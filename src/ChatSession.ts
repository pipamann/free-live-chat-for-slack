import { DurableObject } from 'cloudflare:workers';
import type {
  ChatMessage,
  ChatState,
  ChatStatus,
  ClientMessage,
  Env,
  FileAttachment,
  PendingUpload,
  ServerMessage,
  SlackFile,
  VisitorInfo,
} from './types';
import {
  DELIVERY_RETRY_DELAYS_MS,
  MAX_FILE_SIZE,
  MAX_FRAMES_PER_MINUTE,
  MAX_MESSAGE_LENGTH,
  MAX_MESSAGES_PER_MINUTE,
  MAX_MESSAGES_PER_SESSION,
  MAX_UPLOADS_PER_SESSION,
  SESSION_RESUME_TTL_MS,
  SESSION_RETENTION_MS,
  STAGE_1_DELAY_MS,
  STAGE_2_DELAY_MS,
  UPLOAD_RESERVATION_TTL_MS,
  BOT_DEBOUNCE_MS,
} from './config';
import { SLACK_TEXTS, VISITOR_TEXTS } from './texts';
import {
  downloadSlackFile,
  escapeSlackText,
  isSlackConfigured,
  postSlackMessage,
  quoteForSlack,
  slackToPlainText,
  uploadFileToSlackThread,
} from './slack';
import { contentDisposition, fileKey, normalizeMimeType, sanitizeFilename } from './files';
import { generateBotResponse, isBotEnabled, unansweredVisitorText } from './bot';
import { BOT_NAME } from './prompts';

const STATE_KEY = 'chatState';
const MAX_SOCKETS_PER_SESSION = 20;
const EMAIL_IN_TEXT = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const PHONE = /^\+?[\d ()./-]{6,30}$/;

/**
 * One Durable Object per chat. It holds the transcript, the visitor's WebSocket connections
 * (with hibernation, so idle chats cost nothing) and the link to the chat's Slack thread.
 * The Worker in index.ts calls the public methods over RPC.
 */
export class ChatSession extends DurableObject<Env> {
  private chat: ChatState | null = null;
  private frameTimes: number[] = [];
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private botBusy = false;
  private botRerun = false;
  private slackQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answers the widget's keep-alive pings without waking the object from hibernation
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<ChatState>(STATE_KEY);
      this.chat = stored ? withDefaults(stored) : null;
      // The bot was switched off since this chat started: fall back to the automatic replies
      if (this.chat?.botActive && !isBotEnabled(env)) {
        this.chat.botActive = false;
        await this.save();
        await this.scheduleAlarm();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // RPC methods called by the Worker
  // ---------------------------------------------------------------------------

  /** Creates the chat. Never overwrites an existing one. */
  async init(params: { sessionName: string; visitorInfo?: VisitorInfo; country?: string }): Promise<void> {
    if (this.chat) return;
    this.chat = {
      sessionId: this.ctx.id.toString(),
      sessionName: params.sessionName,
      status: 'active',
      messages: [],
      createdAt: Date.now(),
      visitorInfo: params.visitorInfo,
      country: params.country,
      botActive: isBotEnabled(this.env),
      botReplies: 0,
      recentMessageTimes: [],
      uploadCount: 0,
      pendingUploads: {},
      files: {},
      slackSyncedCount: 0,
      routingSaved: false,
      slackOutbox: [],
      deliveryAttempts: 0,
    };
    await this.save();
    await this.scheduleAlarm();
  }

  /** True if the visitor can continue this chat. Refreshes the page they are on. */
  async resume(visitorInfo?: VisitorInfo): Promise<boolean> {
    const chat = this.chat;
    if (!chat || chat.status === 'ended' || !this.isWithinResumeWindow()) return false;
    if (visitorInfo && JSON.stringify(visitorInfo) !== JSON.stringify(chat.visitorInfo)) {
      chat.visitorInfo = visitorInfo;
      await this.save();
    }
    return true;
  }

  /** Reserves an upload slot. The visitor then sends the file to /upload/complete. */
  async reserveUpload(
    file: Omit<PendingUpload, 'expiresAt'>
  ): Promise<{ fileId: string; expiresAt: number } | { error: string; status: number }> {
    const chat = this.chat;
    if (!chat || chat.status === 'ended' || !this.isWithinResumeWindow()) {
      return { error: 'Chat not found or already closed', status: 404 };
    }
    if (chat.uploadCount >= MAX_UPLOADS_PER_SESSION) {
      return { error: VISITOR_TEXTS.tooManyUploads, status: 429 };
    }
    const now = Date.now();
    for (const [id, pending] of Object.entries(chat.pendingUploads)) {
      if (pending.expiresAt < now) delete chat.pendingUploads[id];
    }
    const fileId = crypto.randomUUID();
    const expiresAt = now + UPLOAD_RESERVATION_TTL_MS;
    chat.pendingUploads[fileId] = { ...file, expiresAt };
    chat.uploadCount++;
    await this.save();
    return { fileId, expiresAt };
  }

  /** Redeems a reservation exactly once. */
  async claimUpload(fileId: string): Promise<PendingUpload | null> {
    const chat = this.chat;
    const pending = chat?.pendingUploads[fileId];
    if (!chat || !pending) return null;
    delete chat.pendingUploads[fileId];
    await this.save();
    if (pending.expiresAt < Date.now() || chat.status === 'ended') return null;
    return pending;
  }

  /** Shows a file the visitor uploaded (already stored in R2) and forwards it to Slack. */
  async addVisitorFile(attachment: FileAttachment, key: string): Promise<void> {
    const chat = this.chat;
    if (!chat) {
      // The chat was deleted while the file was uploading; nothing else would ever delete it
      await this.env.FILES_BUCKET.delete(key);
      return;
    }
    chat.files[attachment.id] = key;
    await this.addVisitorMessage(newMessage('customer', '', { attachments: [attachment] }));
  }

  /** R2 key of a file in this chat, while the chat can still be opened by the visitor. */
  async getFileKey(fileId: string): Promise<string | null> {
    if (!this.chat || !this.isWithinResumeWindow()) return null;
    return this.chat.files[fileId] ?? null;
  }

  /** A reply a team member wrote in the chat's Slack thread. */
  async staffReply(reply: { text: string; staffName?: string; files?: SlackFile[]; channel?: string }): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    if (chat.slackChannel && reply.channel !== chat.slackChannel) {
      console.warn('[ChatSession] Ignoring a reply from another channel');
      return;
    }

    let content = slackToPlainText(reply.text).trim().slice(0, 10_000);
    if (!content && !reply.files?.length) return;

    // A human took over: no more bot replies or automatic messages. Decided before the
    // file downloads, so nothing automatic slips in while they run.
    this.cancelBot();
    chat.botActive = false;
    const statusChanged = chat.status === 'active' || chat.status === 'escalated';
    if (statusChanged) chat.status = 'answered';
    await this.save();
    await this.scheduleAlarm();
    if (statusChanged) this.broadcast({ type: 'status', payload: { status: chat.status } });

    const attachments = reply.files?.length ? await this.storeSlackFiles(reply.files) : [];
    if (!content && attachments.length === 0) content = VISITOR_TEXTS.fileFailed;
    const message = newMessage('staff', content, {
      staffName: reply.staffName,
      attachments: attachments.length ? attachments : undefined,
    });
    chat.messages.push(message);
    await this.save();
    this.broadcast({ type: 'message', payload: message });
    if (statusChanged) await this.updateRoutingRow({ status: chat.status });
  }

  // ---------------------------------------------------------------------------
  // WebSocket (hibernation API)
  // ---------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const chat = this.chat;
    // Chats are only created by /start (which checks Turnstile), never by connecting
    if (!chat || !this.isWithinResumeWindow()) {
      return new Response('Chat not found', { status: 404 });
    }
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS_PER_SESSION) {
      return new Response('Too many connections', { status: 429 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    send(server, { type: 'status', payload: { status: chat.status, messages: chat.messages } });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const chat = this.chat;
    if (!chat) {
      ws.close(4404, 'Chat not found');
      return;
    }
    // Every frame wakes this object, so all of them count, not only chat messages
    const now = Date.now();
    this.frameTimes = this.frameTimes.filter((t) => now - t < 60_000);
    if (this.frameTimes.length >= MAX_FRAMES_PER_MINUTE) {
      ws.close(1008, 'Too many messages');
      return;
    }
    this.frameTimes.push(now);

    let data: ClientMessage;
    try {
      if (typeof raw !== 'string' || raw.length > 16_384) throw new Error('Unexpected frame');
      data = JSON.parse(raw);
    } catch {
      send(ws, { type: 'error', payload: { message: VISITOR_TEXTS.invalidMessage } });
      return;
    }

    if (data?.type === 'message') {
      await this.onVisitorText(ws, data);
    } else if (data?.type === 'email') {
      await this.onContactDetails(ws, data);
    } else if (data?.type !== 'pong') {
      send(ws, { type: 'error', payload: { message: VISITOR_TEXTS.invalidMessage } });
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[ChatSession] WebSocket error:', error);
  }

  // ---------------------------------------------------------------------------
  // Alarm: automatic replies while waiting for staff, and deletion of old chats
  // ---------------------------------------------------------------------------

  async alarm(): Promise<void> {
    const chat = this.chat;
    if (!chat) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }

    const now = Date.now();
    if (now >= deletionTime(chat)) {
      await this.purge();
      return;
    }
    if (chat.deliveryRetryAt !== undefined && now >= chat.deliveryRetryAt) {
      chat.deliveryRetryAt = undefined; // deliver() sets the next one if this attempt fails too
    }

    // Decided before any network call: a staff reply arriving during one must not be overwritten.
    // (Storage writes do not let other events in, Slack and D1 calls do.)
    let escalated = false;
    if (this.waitingForStaff() && chat.firstCustomerMessageAt) {
      if (!chat.stage1Sent && now >= chat.firstCustomerMessageAt + STAGE_1_DELAY_MS) {
        chat.stage1Sent = true;
        await this.addAutoReply(VISITOR_TEXTS.stage1);
      }
      if (!chat.stage2Sent && now >= chat.firstCustomerMessageAt + STAGE_2_DELAY_MS) {
        chat.stage2Sent = true;
        chat.status = 'escalated';
        await this.addAutoReply(VISITOR_TEXTS.stage2);
        this.broadcast({ type: 'status', payload: { status: 'escalated' } });
        escalated = true;
      }
    }
    await this.scheduleAlarm();

    // Network calls last; they also retry whatever could not be delivered earlier
    if (escalated) {
      await this.updateRoutingRow({ status: 'escalated' });
      await this.postNotice(SLACK_TEXTS.stageNotice(escapeSlackText(VISITOR_TEXTS.stage2)));
    } else if (this.hasPendingDelivery()) {
      await this.deliver();
    }
  }

  /** Runs whichever comes first: the next automatic reply, a delivery retry or the deletion of the chat. */
  private async scheduleAlarm(): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    const times = [deletionTime(chat)];
    if (chat.deliveryRetryAt !== undefined) times.push(chat.deliveryRetryAt);
    if (this.waitingForStaff() && chat.firstCustomerMessageAt) {
      if (!chat.stage1Sent) times.push(chat.firstCustomerMessageAt + STAGE_1_DELAY_MS);
      else if (!chat.stage2Sent) times.push(chat.firstCustomerMessageAt + STAGE_2_DELAY_MS);
    }
    await this.ctx.storage.setAlarm(Math.min(...times));
  }

  /** Automatic replies only run while nobody (neither staff nor the bot) has picked up the chat. */
  private waitingForStaff(): boolean {
    return this.chat?.status === 'active' && !this.chat.botActive;
  }

  private async addAutoReply(text: string): Promise<void> {
    const message = newMessage('bot', text, { auto: true });
    this.chat!.messages.push(message);
    await this.save();
    this.broadcast({ type: 'message', payload: message });
  }

  /** Deletes the transcript, files and routing row. Slack keeps its copy of the thread. */
  private async purge(): Promise<void> {
    const chat = this.chat!;
    try {
      const keys = Object.values(chat.files);
      if (keys.length) await this.env.FILES_BUCKET.delete(keys);
      await this.env.DB.prepare('DELETE FROM chat_sessions WHERE id = ?').bind(chat.sessionId).run();
    } catch (error) {
      // Keep everything and retry, rather than leave the email address behind in D1
      console.error('[ChatSession] Deleting the chat failed, retrying in an hour:', error);
      await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
      return;
    }
    this.broadcast({ type: 'status', payload: { status: 'ended', message: VISITOR_TEXTS.expired } });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, 'Chat expired');
      } catch {
        // ignore
      }
    }
    this.chat = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ---------------------------------------------------------------------------
  // Visitor actions
  // ---------------------------------------------------------------------------

  private async onVisitorText(ws: WebSocket, data: Extract<ClientMessage, { type: 'message' }>): Promise<void> {
    const content = typeof data.content === 'string' ? data.content.trim().slice(0, MAX_MESSAGE_LENGTH) : '';
    if (!content || !this.allowVisitorAction(ws)) return;

    const clientId = typeof data.clientId === 'string' ? data.clientId.slice(0, 64) : undefined;
    const message = newMessage('customer', content, { clientId });
    await this.addVisitorMessage(message, ws, clientId);

    const chat = this.chat!;
    const email = chat.customerEmail ? null : EMAIL_IN_TEXT.exec(content)?.[0].toLowerCase();
    if (email) {
      await this.captureEmail(email);
      if (chat.botActive) return; // the bot already confirmed, no need for an answer on top
    }
    if (chat.botActive && chat.status === 'active') this.scheduleBot();
  }

  /** Stores a visitor message, tells the other tabs and forwards it to Slack. */
  private async addVisitorMessage(message: ChatMessage, sender?: WebSocket, clientId?: string): Promise<void> {
    const chat = this.chat!;
    chat.messages.push(message);
    const isFirst = !chat.firstCustomerMessageAt;
    if (isFirst) chat.firstCustomerMessageAt = message.timestamp;
    await this.save();

    if (sender) send(sender, { type: 'message_ack', payload: { id: message.id, clientId } });
    this.broadcast({ type: 'message', payload: message }, sender);
    // Later messages do not push the automatic replies back, or the visitor would never be offered the contact form
    if (isFirst) await this.scheduleAlarm();

    await this.deliver();
  }

  /** Rate limit and size cap for everything a visitor sends. The times are saved with the next change. */
  private allowVisitorAction(ws: WebSocket): boolean {
    const chat = this.chat!;
    const now = Date.now();
    chat.recentMessageTimes = chat.recentMessageTimes.filter((t) => now - t < 60_000);
    if (chat.recentMessageTimes.length >= MAX_MESSAGES_PER_MINUTE) {
      send(ws, { type: 'error', payload: { message: VISITOR_TEXTS.tooManyMessages } });
      return false;
    }
    if (chat.messages.length >= MAX_MESSAGES_PER_SESSION) {
      send(ws, { type: 'error', payload: { message: VISITOR_TEXTS.sessionFull } });
      return false;
    }
    chat.recentMessageTimes.push(now);
    return true;
  }

  /** An email address the visitor typed into a normal message. */
  private async captureEmail(email: string): Promise<void> {
    const chat = this.chat!;
    chat.customerEmail = email;
    await this.save();
    // Confirm when someone is "talking" to the visitor or we asked for contact details
    if (chat.botActive || chat.status === 'escalated') await this.addAutoReply(VISITOR_TEXTS.emailNoted);
    await this.postNotice(escapeSlackText(SLACK_TEXTS.emailCaptured(email)));
    await this.updateRoutingRow({ customer_email: email });
  }

  /** The contact form shown after escalation. Accepted once per chat. */
  private async onContactDetails(ws: WebSocket, data: Extract<ClientMessage, { type: 'email' }>): Promise<void> {
    const chat = this.chat!;
    if (chat.status === 'ended') {
      send(ws, { type: 'error', payload: { message: VISITOR_TEXTS.alreadyEnded } });
      return;
    }
    if (!this.allowVisitorAction(ws)) return;

    const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
    const phone = typeof data.phone === 'string' ? data.phone.trim() : '';
    const emailOk = email.length <= 254 && EMAIL.test(email);
    const phoneOk = PHONE.test(phone);
    if ((email && !emailOk) || (phone && !phoneOk) || (!emailOk && !phoneOk)) {
      send(ws, { type: 'error', payload: { message: VISITOR_TEXTS.invalidContact } });
      return;
    }

    if (emailOk) chat.customerEmail = email;
    if (phoneOk) chat.customerPhone = phone;
    chat.status = 'ended';
    this.cancelBot();
    await this.save();
    await this.scheduleAlarm();
    this.broadcast({ type: 'status', payload: { status: 'ended', message: VISITOR_TEXTS.contactReceived } });

    const ticket = await this.sendTicket();
    const lines = [SLACK_TEXTS.contactLeft];
    if (emailOk) lines.push(`• ${SLACK_TEXTS.email}: ${escapeSlackText(email)}`);
    if (phoneOk) lines.push(`• ${SLACK_TEXTS.phone}: ${escapeSlackText(phone)}`);
    if (ticket !== null) lines.push(ticket ? SLACK_TEXTS.ticketCreated : SLACK_TEXTS.ticketFailed);
    await this.postNotice(lines.join('\n'));
    await this.updateRoutingRow({ status: 'ended', customer_email: chat.customerEmail ?? null });
  }

  /** Sends the transcript to TICKET_WEBHOOK_URL. Returns null if no webhook is configured. */
  private async sendTicket(): Promise<boolean | null> {
    const url = this.env.TICKET_WEBHOOK_URL || this.env.N8N_WEBHOOK_URL;
    if (!url) return null;
    const chat = this.chat!;
    const labels: Record<ChatMessage['role'], string> = { customer: 'Visitor', staff: 'Staff', bot: 'Bot' };
    const transcript = chat.messages
      .map((m) => {
        const text = m.content || (m.attachments ?? []).map((a) => `[File: ${a.name}]`).join(' ');
        // Indented continuation lines, so a message cannot fake a line from someone else
        return `[${labels[m.role]}] ${text.replace(/\n/g, '\n    ')}`;
      })
      .join('\n');
    // File URLs contain the chat's ID, which works like a password: they stay out of third-party systems
    const messages = chat.messages.map((m) =>
      m.attachments ? { ...m, attachments: m.attachments.map(({ url: _url, ...file }) => file) } : m
    );
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.env.TICKET_WEBHOOK_SECRET) headers.Authorization = `Bearer ${this.env.TICKET_WEBHOOK_SECRET}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: chat.customerEmail ?? null,
          phone: chat.customerPhone ?? null,
          session_id: chat.sessionId,
          slack_thread_ts: chat.slackThreadTs ?? null,
          transcript,
          messages,
          visitor_info: chat.visitorInfo ?? null,
          country: chat.country ?? null,
          submitted_at: new Date().toISOString(),
        }),
      });
      if (!response.ok) console.error(`[ChatSession] Ticket webhook returned HTTP ${response.status}`);
      return response.ok;
    } catch (error) {
      console.error('[ChatSession] Ticket webhook failed:', error);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // AI bot
  // ---------------------------------------------------------------------------

  /** Waits briefly for follow-up messages, then answers them together. */
  private scheduleBot(): void {
    this.cancelBot();
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      this.ctx.waitUntil(this.runBot());
    }, BOT_DEBOUNCE_MS);
    // Keeps the object in memory until the timer has fired
    this.ctx.waitUntil(new Promise((resolve) => setTimeout(resolve, BOT_DEBOUNCE_MS + 1000)));
  }

  private cancelBot(): void {
    if (this.botTimer) {
      clearTimeout(this.botTimer);
      this.botTimer = null;
    }
  }

  /** One answer at a time; messages that arrive meanwhile are answered in the next round. */
  private async runBot(): Promise<void> {
    if (this.botBusy) {
      this.botRerun = true;
      return;
    }
    this.botBusy = true;
    try {
      await this.answerWithBot();
    } catch (error) {
      console.error('[ChatSession] Bot failed:', error);
    } finally {
      this.botBusy = false;
      if (this.botRerun) {
        this.botRerun = false;
        this.scheduleBot();
      }
    }
  }

  private async answerWithBot(): Promise<void> {
    const chat = this.chat;
    if (!chat || !chat.botActive || chat.status !== 'active' || !unansweredVisitorText(chat.messages)) return;

    const visitorCount = chat.messages.filter((m) => m.role === 'customer').length;
    this.broadcast({ type: 'typing', payload: { sender: 'bot', name: BOT_NAME } });
    const reply = await generateBotResponse(this.env, chat.messages, chat.botReplies);
    chat.botReplies++;

    // Staff may have answered, or the visitor left their details, while the model was busy
    if (this.chat !== chat || !chat.botActive || chat.status !== 'active') return;
    // New questions arrived meanwhile: answer everything together instead of an outdated reply
    if (chat.messages.filter((m) => m.role === 'customer').length !== visitorCount) {
      this.botRerun = true;
      await this.save();
      return;
    }

    const message = newMessage('bot', reply.content, { isHandoff: reply.needsHandoff || undefined });
    chat.messages.push(message);
    if (reply.needsHandoff) chat.status = 'escalated';
    await this.save();

    this.broadcast({ type: 'message', payload: message });
    if (reply.needsHandoff) {
      this.broadcast({ type: 'status', payload: { status: 'escalated' } });
      await this.updateRoutingRow({ status: 'escalated' });
    }
    await this.postNotice(`${SLACK_TEXTS.botPrefix(BOT_NAME)} ${escapeSlackText(reply.content)}`);
    console.log(
      `[ChatSession] Bot replied (score ${reply.confidence.toFixed(2)}, handoff: ${reply.handoffReason ?? 'no'})`
    );
  }

  // ---------------------------------------------------------------------------
  // Slack
  // ---------------------------------------------------------------------------

  /** Runs Slack calls one at a time, so messages keep their order and only one thread is created. */
  private enqueueSlack(task: () => Promise<void>): Promise<void> {
    const run = this.slackQueue.then(task).catch((error) => console.error('[ChatSession] Slack error:', error));
    this.slackQueue = run;
    return run;
  }

  /**
   * Posts every visitor message that is not in Slack yet. The first one opens the thread.
   * If Slack was unreachable, the next call catches up.
   */
  private async syncVisitorMessages(): Promise<void> {
    const chat = this.chat;
    if (!chat || !isSlackConfigured(this.env)) return;
    const visitorMessages = chat.messages.filter((m) => m.role === 'customer');

    for (const message of visitorMessages.slice(chat.slackSyncedCount)) {
      if (this.chat !== chat) return; // deleted meanwhile
      const text = message.content
        ? quoteForSlack(message.content)
        : (message.attachments ?? []).map((a) => quoteForSlack(SLACK_TEXTS.fileMessage(a.name))).join('\n');

      if (!chat.slackThreadTs) {
        await this.createThread(text);
      } else if (message.content) {
        await postSlackMessage(this.env, text, { threadTs: chat.slackThreadTs });
      }
      for (const attachment of message.attachments ?? []) {
        try {
          await this.uploadVisitorFileToSlack(attachment);
        } catch (error) {
          // A file Slack refuses (e.g. without the files:write scope) must not hold up the rest of the chat
          console.error('[ChatSession] Uploading a file to Slack failed:', error);
          await postSlackMessage(this.env, escapeSlackText(SLACK_TEXTS.fileUploadFailed(attachment.name)), {
            threadTs: chat.slackThreadTs,
          });
        }
      }
      chat.slackSyncedCount++;
      await this.save();
    }
  }

  private async createThread(firstMessage: string): Promise<void> {
    const chat = this.chat!;
    const text = [SLACK_TEXTS.newChat, ...visitorDetails(chat), '', firstMessage].join('\n');
    const { ts, channel } = await postSlackMessage(this.env, text);
    chat.slackThreadTs = ts;
    chat.slackChannel = channel;
    chat.routingSaved = false; // written by deliver() right after this
    await this.save();
  }

  /**
   * Writes the D1 row that lets /slack-webhook find this chat when someone replies in the
   * thread. Three quick attempts; if all fail, deliver() schedules a retry with the alarm.
   */
  private async saveRouting(): Promise<void> {
    const chat = this.chat;
    if (!chat?.slackThreadTs || chat.routingSaved) return;
    const statement = this.env.DB.prepare(
      'INSERT OR REPLACE INTO chat_sessions (id, slack_thread_ts, status, customer_email, session_name) VALUES (?, ?, ?, ?, ?)'
    ).bind(chat.sessionId, chat.slackThreadTs, chat.status, chat.customerEmail ?? null, chat.sessionName);
    for (const pause of [0, 300, 1500]) {
      if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
      // A chat deleted meanwhile must not get its row (with the email address) back
      if (this.chat !== chat) return;
      try {
        await statement.run();
      } catch (error) {
        console.error('[ChatSession] Saving the Slack routing row failed:', error);
        continue;
      }
      if (this.chat !== chat) {
        // Deleted while the insert was on its way
        await this.env.DB.prepare('DELETE FROM chat_sessions WHERE id = ?').bind(chat.sessionId).run();
        return;
      }
      chat.routingSaved = true;
      await this.save();
      return;
    }
    throw new Error('The Slack routing row could not be saved');
  }

  /** A notice for the team (bot reply, contact details…). It stays in the outbox until Slack accepts it. */
  private async postNotice(text: string): Promise<void> {
    const chat = this.chat;
    if (!chat || !isSlackConfigured(this.env)) return;
    chat.slackOutbox.push(text);
    await this.save();
    await this.deliver();
  }

  /** Posts waiting notices in order; each one leaves the outbox only once Slack has accepted it. */
  private async flushNotices(): Promise<void> {
    const chat = this.chat;
    while (chat && this.chat === chat && chat.slackThreadTs && chat.slackOutbox.length > 0) {
      await postSlackMessage(this.env, chat.slackOutbox[0], { threadTs: chat.slackThreadTs });
      chat.slackOutbox.shift();
      await this.save();
    }
  }

  /**
   * Brings Slack up to date: visitor messages (the first opens the thread), the D1 routing row,
   * then waiting notices. If anything fails, the alarm tries again after each of
   * DELIVERY_RETRY_DELAYS_MS and then stops; the visitor's next message tries again too.
   */
  private deliver(): Promise<void> {
    return this.enqueueSlack(async () => {
      const chat = this.chat;
      if (!chat || !isSlackConfigured(this.env)) return;
      try {
        await this.syncVisitorMessages();
        await this.saveRouting();
        await this.flushNotices();
        if (chat.deliveryAttempts === 0 && chat.deliveryRetryAt === undefined) return;
        chat.deliveryAttempts = 0;
        chat.deliveryRetryAt = undefined;
      } catch (error) {
        console.error('[ChatSession] Delivering to Slack failed:', error);
        const delay = DELIVERY_RETRY_DELAYS_MS[chat.deliveryAttempts];
        chat.deliveryAttempts++;
        chat.deliveryRetryAt = delay === undefined ? undefined : Date.now() + delay;
      }
      if (this.chat !== chat) return; // deleted meanwhile
      await this.save();
      await this.scheduleAlarm();
    });
  }

  private hasPendingDelivery(): boolean {
    const chat = this.chat;
    if (!chat || !isSlackConfigured(this.env)) return false;
    const visitorMessages = chat.messages.filter((m) => m.role === 'customer').length;
    return (
      chat.slackSyncedCount < visitorMessages ||
      chat.slackOutbox.length > 0 ||
      (!!chat.slackThreadTs && !chat.routingSaved)
    );
  }

  private async uploadVisitorFileToSlack(attachment: FileAttachment): Promise<void> {
    const chat = this.chat!;
    const key = chat.files[attachment.id];
    const object = key ? await this.env.FILES_BUCKET.get(key) : null;
    if (!object || !chat.slackThreadTs) return;
    await uploadFileToSlackThread(
      this.env,
      chat.slackThreadTs,
      { name: attachment.name, bytes: await object.arrayBuffer() },
      escapeSlackText(SLACK_TEXTS.fileUploaded(attachment.name))
    );
  }

  /** Copies files a team member attached in Slack to R2, so the visitor can download them. */
  private async storeSlackFiles(files: SlackFile[]): Promise<FileAttachment[]> {
    const chat = this.chat!;
    if (!chat.sessionName) return []; // chats created before v1.1 have no public ID for file URLs

    const stored = await Promise.all(
      files.slice(0, 10).map(async (file): Promise<FileAttachment | null> => {
        const mimeType = normalizeMimeType(file.mimetype);
        if (!mimeType || !(file.size > 0) || file.size > MAX_FILE_SIZE) {
          console.warn(`[ChatSession] Skipping Slack file of type ${file.mimetype}, ${file.size} bytes`);
          return null;
        }
        try {
          const response = await downloadSlackFile(this.env, file);
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength > MAX_FILE_SIZE) return null;
          const fileId = crypto.randomUUID();
          const name = sanitizeFilename(file.name, mimeType);
          const key = fileKey(chat.sessionName, fileId);
          await this.env.FILES_BUCKET.put(key, bytes, {
            httpMetadata: { contentType: mimeType, contentDisposition: contentDisposition(name) },
            customMetadata: { source: 'slack', slackFileId: file.id },
          });
          chat.files[fileId] = key;
          return { id: fileId, name, mimeType, size: bytes.byteLength, url: `/file/${chat.sessionName}/${fileId}` };
        } catch (error) {
          console.error('[ChatSession] Copying a Slack file failed:', error);
          return null;
        }
      })
    );
    return stored.filter((file): file is FileAttachment => file !== null);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private isWithinResumeWindow(): boolean {
    return !!this.chat && Date.now() - this.chat.createdAt < SESSION_RESUME_TTL_MS;
  }

  private async save(): Promise<void> {
    if (this.chat) await this.ctx.storage.put(STATE_KEY, this.chat);
  }

  private async updateRoutingRow(fields: { status?: ChatStatus; customer_email?: string | null }): Promise<void> {
    const chat = this.chat;
    if (!chat?.slackThreadTs) return;
    const columns = Object.keys(fields);
    try {
      await this.env.DB.prepare(`UPDATE chat_sessions SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .bind(...Object.values(fields), chat.sessionId)
        .run();
    } catch (error) {
      console.error('[ChatSession] D1 update failed:', error);
    }
  }

  private broadcast(message: ServerMessage, except?: WebSocket): void {
    const data = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        // The socket is closing
      }
    }
  }
}

/**
 * Chats the visitor never wrote in are deleted once they can no longer be resumed;
 * real conversations are kept for the retention period.
 */
function deletionTime(chat: ChatState): number {
  return chat.createdAt + (chat.firstCustomerMessageAt ? SESSION_RETENTION_MS : SESSION_RESUME_TTL_MS);
}

function send(ws: WebSocket, message: ServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The socket is closing
  }
}

function newMessage(
  role: ChatMessage['role'],
  content: string,
  extra: Partial<Pick<ChatMessage, 'staffName' | 'attachments' | 'isHandoff' | 'auto' | 'clientId'>> = {}
): ChatMessage {
  return { id: crypto.randomUUID(), role, content, timestamp: Date.now(), ...extra };
}

/** Fills in fields added in v1.1 for chats stored by older versions, and drops the stored IP address. */
function withDefaults(stored: ChatState & { ipAddress?: string }): ChatState {
  const { ipAddress: _dropped, ...state } = stored;
  const visitorMessageCount = state.messages.filter((m) => m.role === 'customer').length;
  return {
    ...state,
    sessionName: state.sessionName ?? '',
    uploadCount: state.uploadCount ?? 0,
    pendingUploads: state.pendingUploads ?? {},
    files: state.files ?? {},
    slackSyncedCount: state.slackSyncedCount ?? (state.slackThreadTs ? visitorMessageCount : 0),
    routingSaved: state.routingSaved ?? Boolean(state.slackThreadTs),
    slackOutbox: state.slackOutbox ?? [],
    deliveryAttempts: state.deliveryAttempts ?? 0,
    botReplies: state.botReplies ?? 0,
    recentMessageTimes: state.recentMessageTimes ?? [],
  };
}

/** Lines about the visitor for the thread's first post. All values are escaped. */
export function visitorDetails(chat: Pick<ChatState, 'country' | 'visitorInfo'>): string[] {
  const lines: string[] = [];
  const info = chat.visitorInfo;
  if (chat.country || info?.userAgent) {
    const { browser, os, device } = parseUserAgent(info?.userAgent);
    const language = info?.language ? ` | ${info.language}` : '';
    lines.push(`*${SLACK_TEXTS.visitor}*: ${countryLabel(chat.country)} | ${browser}/${os} | ${device}${language}`);
  }
  // Only values that parse as URLs are shown, never free text from the visitor
  const page = parseUrl(info?.pageUrl);
  if (page) lines.push(`*${SLACK_TEXTS.page}*: ${page.pathname}${page.search}`);
  const referrer = parseUrl(info?.referrer);
  if (referrer) lines.push(`*${SLACK_TEXTS.referrer}*: ${referrer.hostname}`);
  return lines.map(escapeSlackText);
}

function parseUrl(value: string | undefined): URL | null {
  try {
    const url = value ? new URL(value) : null;
    return url && (url.protocol === 'https:' || url.protocol === 'http:') ? url : null;
  } catch {
    return null;
  }
}

function countryLabel(code: string | undefined): string {
  if (!code || !/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'T1') return `🌍 ${SLACK_TEXTS.unknown}`;
  const flag = String.fromCodePoint(...[...code].map((char) => 127397 + char.charCodeAt(0)));
  let name = code;
  try {
    name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    // keep the code
  }
  return `${flag} ${name}`;
}

export function parseUserAgent(ua: string | undefined): { browser: string; os: string; device: string } {
  const unknown = SLACK_TEXTS.unknown;
  if (!ua) return { browser: unknown, os: unknown, device: unknown };

  let browser = unknown;
  if (ua.includes('Firefox/')) browser = 'Firefox';
  else if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('OPR/') || ua.includes('Opera')) browser = 'Opera';
  else if (ua.includes('Chrome/') || ua.includes('CriOS/')) browser = 'Chrome';
  else if (ua.includes('Safari/')) browser = 'Safari';

  let os = unknown;
  if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS')) os = 'macOS';
  else if (ua.includes('Linux')) os = 'Linux';

  let device = 'Desktop';
  if (/iPad|Tablet/.test(ua)) device = 'Tablet';
  else if (/Mobile|iPhone|Android/.test(ua)) device = 'Mobile';

  return { browser, os, device };
}
