import type { Env, ChatMessage, ChatState, WebSocketMessage, CustomerMessage, EmailSubmission, VisitorInfo, FileAttachment, SlackFile } from './types';
import { generateBotResponse } from './bot';
import { BOT_NAME, EMAIL_REGEX, EMAIL_CAPTURED_RESPONSE } from './prompts';

const TIMEOUT_MS = 60_000; // 60 seconds
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
];

// SSRF validation - only allow Slack file URLs
function isValidSlackFileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['files.slack.com', 'files-origin.slack.com'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

// Sanitize filename - remove path traversal and dangerous characters
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[\/\\]/g, '') // Remove path separators
    .replace(/\.\./g, '') // Remove parent directory references
    .replace(/[<>:"|?*]/g, '') // Remove Windows-forbidden chars
    .slice(0, 255); // Limit length
}

// Country code to flag emoji mapping
function countryToFlag(countryCode: string | undefined): string {
  if (!countryCode || countryCode.length !== 2) return '🌍';
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map((char) => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

// Country code to name (common countries)
function countryCodeToName(code: string | undefined): string {
  const countries: Record<string, string> = {
    DE: 'Deutschland',
    AT: 'Österreich',
    CH: 'Schweiz',
    US: 'USA',
    GB: 'UK',
    FR: 'Frankreich',
    NL: 'Niederlande',
    BE: 'Belgien',
    IT: 'Italien',
    ES: 'Spanien',
  };
  return code ? countries[code] || code : 'Unbekannt';
}

// Parse user agent for browser and OS
function parseUserAgent(ua: string | undefined): { browser: string; os: string; device: string } {
  if (!ua) return { browser: 'Unbekannt', os: 'Unbekannt', device: 'Unbekannt' };

  // Browser detection
  let browser = 'Unbekannt';
  if (ua.includes('Firefox')) browser = 'Firefox';
  else if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('Chrome')) browser = 'Chrome';
  else if (ua.includes('Safari')) browser = 'Safari';
  else if (ua.includes('Opera') || ua.includes('OPR')) browser = 'Opera';

  // OS detection
  let os = 'Unbekannt';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS')) os = 'Mac';
  else if (ua.includes('Linux')) os = 'Linux';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';

  // Device type
  let device = 'Desktop';
  if (ua.includes('Mobile') || ua.includes('Android') || ua.includes('iPhone')) {
    device = 'Mobile';
  } else if (ua.includes('iPad') || ua.includes('Tablet')) {
    device = 'Tablet';
  }

  return { browser, os, device };
}
const GRACE_PERIOD_MS = 5_000; // 5 second grace period
const MAX_MESSAGE_LENGTH = 1000;
const MAX_MESSAGES_PER_MINUTE = 10;
const HEARTBEAT_INTERVAL_MS = 30_000;
const BOT_DEBOUNCE_MS = 2_000; // Wait 2s for follow-up messages before bot responds

export class ChatSession implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private websockets: Set<WebSocket> = new Set();
  private chatState: ChatState | null = null;
  private messageTimestamps: number[] = [];
  private heartbeatInterval: number | null = null;
  private botDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Restore WebSockets from hibernation
    this.state.getWebSockets().forEach((ws) => {
      this.websockets.add(ws);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/websocket') {
      return this.handleWebSocket(request);
    }

    if (url.pathname === '/staff-message' && request.method === 'POST') {
      return this.handleStaffMessage(request);
    }

    if (url.pathname === '/state' && request.method === 'GET') {
      return this.getState();
    }

    if (url.pathname === '/init' && request.method === 'POST') {
      return this.handleInit(request);
    }

    if (url.pathname === '/update-visitor' && request.method === 'POST') {
      return this.handleUpdateVisitor(request);
    }

    if (url.pathname === '/file-uploaded' && request.method === 'POST') {
      return this.handleFileUploaded(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  private async handleInit(request: Request): Promise<Response> {
    try {
      const { sessionName, visitorInfo, ipAddress, country } = (await request.json()) as {
        sessionName?: string;
        visitorInfo?: VisitorInfo;
        ipAddress?: string;
        country?: string;
      };

      this.chatState = {
        sessionId: this.state.id.toString(),
        sessionName, // Store UUID for R2 file paths
        status: 'active',
        messages: [],
        createdAt: Date.now(),
        visitorInfo,
        ipAddress,
        country,
        // Bot state - enabled by default
        botActive: true,
        botMessageCount: 0,
      };
      await this.state.storage.put('chatState', this.chatState);

      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('[ChatSession] Init error:', error);
      return new Response('Error', { status: 500 });
    }
  }

  private async handleUpdateVisitor(request: Request): Promise<Response> {
    try {
      // Load state from storage if not in memory
      if (!this.chatState) {
        this.chatState = (await this.state.storage.get<ChatState>('chatState')) ?? null;
      }
      if (!this.chatState) {
        return new Response('Session not found', { status: 404 });
      }

      const { visitorInfo } = (await request.json()) as { visitorInfo?: VisitorInfo };

      if (visitorInfo) {
        this.chatState.visitorInfo = visitorInfo;
        await this.state.storage.put('chatState', this.chatState);
      }

      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('[ChatSession] Update visitor error:', error);
      return new Response('Error', { status: 500 });
    }
  }

  private async handleFileUploaded(request: Request): Promise<Response> {
    try {
      // Load state from storage if not in memory
      if (!this.chatState) {
        this.chatState = (await this.state.storage.get<ChatState>('chatState')) ?? null;
      }
      if (!this.chatState) {
        return new Response('Session not found', { status: 404 });
      }

      const { attachment } = (await request.json()) as {
        attachment: FileAttachment;
        r2Key: string;
      };

      // Create message with attachment
      const message: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'customer',
        content: '', // Empty content, file only
        timestamp: Date.now(),
        attachments: [attachment],
      };

      this.chatState.messages.push(message);
      await this.state.storage.put('chatState', this.chatState);

      // Broadcast to all connected clients
      this.broadcast({
        type: 'message',
        payload: message,
      });

      // If this is the first message, create Slack thread
      // (though likely the file was sent after initial message)
      if (this.chatState.messages.filter((m) => m.role === 'customer').length === 1) {
        await this.createSlackThread(`📎 [Datei: ${attachment.name}]`);
        await this.state.storage.setAlarm(Date.now() + TIMEOUT_MS + GRACE_PERIOD_MS);
      }

      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('[ChatSession] File uploaded error:', error);
      return new Response('Error', { status: 500 });
    }
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Accept with hibernation support
    this.state.acceptWebSocket(server);
    this.websockets.add(server);

    // Load or initialize chat state
    if (!this.chatState) {
      // First try to load from storage (e.g., after hibernation)
      this.chatState = (await this.state.storage.get<ChatState>('chatState')) ?? null;

      // If still not found, create new state
      if (!this.chatState) {
        const sessionId = this.state.id.toString();
        this.chatState = {
          sessionId,
          status: 'active',
          messages: [],
          createdAt: Date.now(),
          botActive: true,
          botMessageCount: 0,
        };
        await this.state.storage.put('chatState', this.chatState);
      }
    }

    // Send current state to new connection
    this.sendToSocket(server, {
      type: 'status',
      payload: {
        status: this.chatState.status,
        messages: this.chatState.messages,
      },
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    try {
      const data = JSON.parse(message) as CustomerMessage | EmailSubmission | { type: 'pong' };

      if (data.type === 'pong') {
        // Client responded to ping, connection is alive
        return;
      }

      if (data.type === 'message') {
        await this.handleCustomerMessage(data as CustomerMessage, ws);
      } else if (data.type === 'email') {
        await this.handleEmailSubmission(data as EmailSubmission);
      }
    } catch (error) {
      console.error('[ChatSession] Error processing message:', error);
      this.sendToSocket(ws, {
        type: 'error',
        payload: { message: 'Invalid message format' },
      });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.websockets.delete(ws);

    // If no more connections and chat not ended, keep state for potential reconnect
    if (this.websockets.size === 0 && this.chatState?.status !== 'ended') {
      // Session state persists in DO storage
      console.log(`[ChatSession] All connections closed for session ${this.chatState?.sessionId}`);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[ChatSession] WebSocket error:', error);
    this.websockets.delete(ws);
  }

  async alarm(): Promise<void> {
    // Load state from storage if not in memory (e.g., after hibernation)
    if (!this.chatState) {
      this.chatState = (await this.state.storage.get<ChatState>('chatState')) ?? null;
    }

    if (!this.chatState) return;

    // Check if we're still in active status (no staff response)
    if (this.chatState.status === 'active') {
      // Add grace period - check if staff or bot replied in the last few seconds
      const lastMessage = this.chatState.messages[this.chatState.messages.length - 1];
      if (lastMessage?.role === 'staff') {
        // Staff replied during grace period, don't escalate
        return;
      }
      // If bot responded recently and is still active (and it wasn't a handoff), extend the timeout
      if (lastMessage?.role === 'bot' && this.chatState.botActive && !lastMessage.isHandoff) {
        // Bot is actively handling the conversation, wait for more interaction
        await this.state.storage.setAlarm(Date.now() + TIMEOUT_MS + GRACE_PERIOD_MS);
        return;
      }

      // Request email from customer
      this.chatState.status = 'escalated';

      // Add escalation message as a bot message so it appears in chat
      const escalationMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'bot',
        content: 'Es tut mir leid, ich konnte leider keinen freien Mitarbeiter erreichen. Sie können aber gerne weiter mit mir chatten! Falls Sie möchten, dass sich ein Mitarbeiter bei Ihnen meldet, können Sie unten Ihre E-Mail-Adresse hinterlassen.',
        timestamp: Date.now(),
      };
      this.chatState.messages.push(escalationMessage);

      await this.state.storage.put('chatState', this.chatState);

      // Send the message to customers
      this.broadcast({
        type: 'message',
        payload: escalationMessage,
      });

      this.broadcast({
        type: 'status',
        payload: {
          status: 'escalated',
        },
      });
    }
  }

  private async handleCustomerMessage(data: CustomerMessage, senderWs: WebSocket): Promise<void> {
    // Load state from storage if not in memory (e.g., after hibernation)
    if (!this.chatState) {
      this.chatState = (await this.state.storage.get<ChatState>('chatState')) ?? null;
    }

    if (!this.chatState) return;

    // Rate limiting
    const now = Date.now();
    this.messageTimestamps = this.messageTimestamps.filter((t) => now - t < 60_000);
    if (this.messageTimestamps.length >= MAX_MESSAGES_PER_MINUTE) {
      this.sendToSocket(senderWs, {
        type: 'error',
        payload: { message: 'Zu viele Nachrichten. Bitte warten Sie einen Moment.' },
      });
      return;
    }
    this.messageTimestamps.push(now);

    // Validate and sanitize message
    const content = data.content?.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!content) return;

    // Create message
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'customer',
      content,
      timestamp: now,
    };

    this.chatState.messages.push(message);
    await this.state.storage.put('chatState', this.chatState);

    // Send acknowledgment to sender (with message ID for client-side tracking)
    this.sendToSocket(senderWs, {
      type: 'message_ack',
      payload: { id: message.id },
    });

    // Broadcast to OTHER connected clients (e.g., other tabs)
    this.broadcastExcept(senderWs, {
      type: 'message',
      payload: message,
    });

    // Reset alarm on EVERY customer message to keep session alive while user is active
    if (this.chatState.status === 'active') {
      await this.state.storage.setAlarm(Date.now() + TIMEOUT_MS + GRACE_PERIOD_MS);
    }

    // If this is the first message, post to Slack
    if (this.chatState.messages.filter((m) => m.role === 'customer').length === 1) {
      await this.createSlackThread(content);
    } else if (this.chatState.slackThreadTs) {
      // Post follow-up message to existing thread
      await this.postToSlackThread(content);
    }

    // Check if customer provided an email address
    const extractedEmail = this.extractEmail(content);
    if (extractedEmail && !this.chatState.customerEmail) {
      await this.handleEmailExtracted(extractedEmail);
      return; // Don't trigger bot response - we already responded
    }

    // Trigger bot response if bot is active and session is still active
    if (this.chatState.botActive && this.chatState.status === 'active') {
      this.scheduleBotResponse(content);
    }
  }

  /**
   * Extract email address from message content
   */
  private extractEmail(content: string): string | null {
    const match = content.match(EMAIL_REGEX);
    return match ? match[0].toLowerCase() : null;
  }

  /**
   * Handle when customer provides their email address
   */
  private async handleEmailExtracted(email: string): Promise<void> {
    if (!this.chatState) return;

    // Store the email
    this.chatState.customerEmail = email;
    await this.state.storage.put('chatState', this.chatState);

    // Create confirmation message from bot
    const botMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'bot',
      content: EMAIL_CAPTURED_RESPONSE,
      timestamp: Date.now(),
    };

    this.chatState.messages.push(botMessage);
    await this.state.storage.put('chatState', this.chatState);

    // Broadcast confirmation to customer
    this.broadcast({
      type: 'message',
      payload: botMessage,
    });

    // Notify staff in Slack thread
    if (this.chatState.slackThreadTs) {
      await this.postToSlackThread(`📧 E-Mail erfasst: ${email}`);
    }

    // Update D1 with customer email
    try {
      await this.env.DB.prepare(
        'UPDATE chat_sessions SET customer_email = ? WHERE id = ?'
      )
        .bind(email, this.chatState.sessionId)
        .run();
    } catch (error) {
      console.error('[ChatSession] D1 email update error:', error);
    }

    console.log(`[ChatSession] Email captured: ${email}`);
  }

  private async handleEmailSubmission(data: EmailSubmission): Promise<void> {
    // Load state from storage if not in memory (e.g., after hibernation)
    if (!this.chatState) {
      this.chatState = (await this.state.storage.get<ChatState>('chatState')) ?? null;
    }

    if (!this.chatState) return;

    const email = data.email?.trim().toLowerCase();
    if (!email || !this.isValidEmail(email)) {
      this.broadcast({
        type: 'error',
        payload: { message: 'Bitte geben Sie eine gültige E-Mail-Adresse ein.' },
      });
      return;
    }

    this.chatState.customerEmail = email;
    this.chatState.status = 'ended';
    await this.state.storage.put('chatState', this.chatState);

    // Create Freshdesk ticket
    await this.createFreshdeskTicket(email);

    // Update Slack thread
    if (this.chatState.slackThreadTs) {
      await this.postToSlackThread(`📧 Kunde hat E-Mail hinterlassen: ${email}\n🎫 Freshdesk-Ticket wurde erstellt.`);
    }

    // Update D1
    try {
      await this.env.DB.prepare(
        'UPDATE chat_sessions SET status = ?, customer_email = ? WHERE id = ?'
      )
        .bind('ended', email, this.chatState.sessionId)
        .run();
    } catch (error) {
      console.error('[ChatSession] D1 update error:', error);
    }

    this.broadcast({
      type: 'status',
      payload: {
        status: 'ended',
        message: 'Vielen Dank! Wir haben ein Support-Ticket erstellt und melden uns bei Ihnen per E-Mail.',
      },
    });
  }

  private async handleStaffMessage(request: Request): Promise<Response> {
    // Load state from storage if not in memory (e.g., after hibernation)
    if (!this.chatState) {
      this.chatState = (await this.state.storage.get<ChatState>('chatState')) ?? null;
    }

    if (!this.chatState) {
      return new Response('Session not found', { status: 404 });
    }

    try {
      const body = (await request.json()) as {
        text: string;
        staffName?: string;
        pendingFiles?: SlackFile[];
        sessionName?: string;
      };
      const content = body.text?.trim() || '';
      const hasPendingFiles = body.pendingFiles && body.pendingFiles.length > 0;

      // Allow empty text if there are pending files
      if (!content && !hasPendingFiles) {
        return new Response('Empty message', { status: 400 });
      }

      // Disable bot when staff replies
      if (this.chatState.botActive) {
        this.chatState.botActive = false;
        // Cancel any pending bot response
        if (this.botDebounceTimer) {
          clearTimeout(this.botDebounceTimer);
          this.botDebounceTimer = null;
        }
      }

      // Update status if this is first staff response
      if (this.chatState.status === 'active') {
        this.chatState.status = 'answered';
        // Cancel the timeout alarm
        await this.state.storage.deleteAlarm();

        // Update D1
        try {
          await this.env.DB.prepare('UPDATE chat_sessions SET status = ? WHERE id = ?')
            .bind('answered', this.chatState.sessionId)
            .run();
        } catch (error) {
          console.error('[ChatSession] D1 update error:', error);
        }
      }

      const message: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'staff',
        content,
        timestamp: Date.now(),
        staffName: body.staffName,
      };

      // Process pending files if any
      if (hasPendingFiles && body.sessionName) {
        const attachments = await this.processSlackFiles(body.pendingFiles!, body.sessionName);
        if (attachments.length > 0) {
          message.attachments = attachments;
        } else if (!content) {
          // All files failed and no text provided - show error instead of blank message
          message.content = '[Fehler: Datei konnte nicht geladen werden]';
        }
      }

      this.chatState.messages.push(message);
      await this.state.storage.put('chatState', this.chatState);

      // Broadcast to customer
      this.broadcast({
        type: 'message',
        payload: message,
      });

      this.broadcast({
        type: 'status',
        payload: { status: this.chatState.status },
      });

      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('[ChatSession] Staff message error:', error);
      return new Response('Error', { status: 500 });
    }
  }

  /**
   * Download files from Slack and upload to R2
   * Processes files in parallel for better performance
   */
  private async processSlackFiles(files: SlackFile[], sessionName: string): Promise<FileAttachment[]> {
    const processFile = async (file: SlackFile): Promise<FileAttachment | null> => {
      try {
        // Double-check SSRF validation
        if (!isValidSlackFileUrl(file.url_private)) {
          console.warn(`[ChatSession] Skipping file with invalid URL: ${file.url_private}`);
          return null;
        }

        // Validate MIME type
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
          console.warn(`[ChatSession] Skipping unsupported file type: ${file.mimetype}`);
          return null;
        }

        // Validate size
        if (file.size > MAX_FILE_SIZE) {
          console.warn(`[ChatSession] Skipping oversized file: ${file.size} bytes`);
          return null;
        }

        // Download file from Slack
        // Use manual redirect to strip Auth header when following redirect to S3
        let downloadResponse = await fetch(file.url_private, {
          headers: {
            Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
          },
          redirect: 'manual',
        });

        // Follow redirect (usually to S3) without the Authorization header
        if (downloadResponse.status === 301 || downloadResponse.status === 302) {
          const location = downloadResponse.headers.get('Location');
          if (location) {
            downloadResponse = await fetch(location);
          }
        }

        if (!downloadResponse.ok) {
          console.error(`[ChatSession] Failed to download Slack file: ${downloadResponse.status}`);
          return null;
        }

        // Generate file ID and R2 key
        const fileId = crypto.randomUUID();
        const sanitizedName = sanitizeFilename(file.name);
        const r2Key = `${sessionName}/${fileId}/${sanitizedName}`;

        // Upload to R2
        await this.env.FILES_BUCKET.put(r2Key, downloadResponse.body, {
          httpMetadata: {
            contentType: file.mimetype,
            contentDisposition: `attachment; filename="${sanitizedName}"`,
          },
          customMetadata: {
            sessionId: sessionName,
            source: 'slack-staff',
            slackFileId: file.id,
            uploadedAt: new Date().toISOString(),
          },
        });

        console.log(`[ChatSession] Uploaded Slack file ${file.name} to R2: ${r2Key}`);

        return {
          id: fileId,
          name: sanitizedName,
          mimeType: file.mimetype,
          size: file.size,
          url: `/file/${sessionName}/${fileId}`,
        };
      } catch (error) {
        console.error(`[ChatSession] Error processing Slack file ${file.name}:`, error);
        return null;
      }
    };

    // Process all files in parallel
    const results = await Promise.all(files.map(processFile));

    // Filter out failed uploads (nulls)
    return results.filter((attachment): attachment is FileAttachment => attachment !== null);
  }

  /**
   * Schedule a bot response with debouncing
   * Waits for follow-up messages before generating a response
   */
  private scheduleBotResponse(content: string): void {
    // Cancel any existing debounce timer
    if (this.botDebounceTimer) {
      clearTimeout(this.botDebounceTimer);
    }

    // Schedule the bot response after debounce period
    this.botDebounceTimer = setTimeout(() => {
      this.state.waitUntil(this.executeBotResponse());
    }, BOT_DEBOUNCE_MS);
  }

  /**
   * Execute the bot response generation and send to customer
   */
  private async executeBotResponse(): Promise<void> {
    // Reload state in case it changed
    if (!this.chatState) {
      this.chatState = (await this.state.storage.get<ChatState>('chatState')) ?? null;
    }

    if (!this.chatState || !this.chatState.botActive || this.chatState.status !== 'active') {
      return;
    }

    // Get the latest customer message
    const customerMessages = this.chatState.messages.filter((m) => m.role === 'customer');
    if (customerMessages.length === 0) return;

    const latestMessage = customerMessages[customerMessages.length - 1];

    try {
      // Send typing indicator
      this.broadcast({
        type: 'typing',
        payload: { sender: 'bot', name: BOT_NAME },
      });

      // Generate bot response
      const response = await generateBotResponse(
        this.env,
        this.chatState.messages,
        latestMessage.content
      );

      // Re-check state after async AI call (staff may have replied during generation)
      this.chatState = (await this.state.storage.get<ChatState>('chatState')) ?? null;
      if (!this.chatState || !this.chatState.botActive || this.chatState.status !== 'active') {
        console.log('[ChatSession] Bot response discarded - state changed during generation');
        return;
      }

      // Clear typing indicator (by sending the actual message)

      // Create bot message
      const botMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'bot',
        content: response.content,
        timestamp: Date.now(),
        botConfidence: response.confidence,
        isHandoff: response.needsHandoff,
      };

      // If bot detected handoff needed, escalate immediately
      if (response.needsHandoff) {
        this.chatState.status = 'escalated';
      }

      this.chatState.messages.push(botMessage);
      this.chatState.botMessageCount = (this.chatState.botMessageCount || 0) + 1;
      this.chatState.lastBotResponse = Date.now();
      await this.state.storage.put('chatState', this.chatState);

      // Broadcast to customer
      this.broadcast({
        type: 'message',
        payload: botMessage,
      });

      // If handoff, broadcast status change immediately so UI shows email form
      if (response.needsHandoff) {
        this.broadcast({
          type: 'status',
          payload: { status: 'escalated' },
        });
      }

      // Post bot message to Slack thread (so staff can see the conversation)
      if (this.chatState.slackThreadTs) {
        await this.postToSlackThread(`🤖 ${BOT_NAME}: ${response.content}`);
      }

      // Reset escalation alarm since bot is actively helping
      // Only if bot is still providing value (not a handoff response)
      if (!response.needsHandoff) {
        await this.state.storage.setAlarm(Date.now() + TIMEOUT_MS + GRACE_PERIOD_MS);
      }

      console.log(
        `[ChatSession] Bot responded with confidence ${response.confidence.toFixed(2)}, handoff: ${response.needsHandoff}`
      );
    } catch (error) {
      console.error('[ChatSession] Bot response error:', error);
      // Don't send error to customer - just let the escalation timer handle it
    }
  }

  private async getState(): Promise<Response> {
    // Always load from storage to handle hibernation correctly
    if (!this.chatState) {
      this.chatState = (await this.state.storage.get<ChatState>('chatState')) ?? null;
    }
    return new Response(JSON.stringify(this.chatState), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async createSlackThread(firstMessage: string): Promise<void> {
    if (!this.env.SLACK_BOT_TOKEN || !this.env.SLACK_CHANNEL_ID) {
      console.warn('[ChatSession] Slack not configured');
      return;
    }

    try {
      // Build visitor info section
      const visitorLines: string[] = [];
      if (this.chatState?.country || this.chatState?.visitorInfo?.userAgent) {
        const flag = countryToFlag(this.chatState.country);
        const countryName = countryCodeToName(this.chatState.country);
        const { browser, os, device } = parseUserAgent(this.chatState.visitorInfo?.userAgent);
        visitorLines.push(`*Besucher*: ${flag} ${countryName} | ${browser}/${os} | ${device}`);
      }
      if (this.chatState?.visitorInfo?.pageUrl) {
        // Extract path from URL
        try {
          const pageUrl = new URL(this.chatState.visitorInfo.pageUrl);
          visitorLines.push(`*Seite*: ${pageUrl.pathname}${pageUrl.search}`);
        } catch {
          visitorLines.push(`*Seite*: ${this.chatState.visitorInfo.pageUrl}`);
        }
      }
      if (this.chatState?.visitorInfo?.referrer) {
        // Extract domain from referrer
        try {
          const referrerUrl = new URL(this.chatState.visitorInfo.referrer);
          visitorLines.push(`*Referrer*: ${referrerUrl.hostname}`);
        } catch {
          visitorLines.push(`*Referrer*: ${this.chatState.visitorInfo.referrer}`);
        }
      }

      const visitorSection = visitorLines.length > 0 ? visitorLines.join('\n') + '\n\n' : '';

      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: this.env.SLACK_CHANNEL_ID,
          text: `💬 *Neue Live-Chat Anfrage*\n\n${visitorSection}> ${firstMessage}`,
          metadata: {
            event_type: 'live_chat_session',
            event_payload: {
              session_id: this.chatState?.sessionId,
            },
          },
        }),
      });

      const result = (await response.json()) as { ok: boolean; ts?: string; error?: string };
      if (result.ok && result.ts) {
        this.chatState!.slackThreadTs = result.ts;
        await this.state.storage.put('chatState', this.chatState);

        // Save to D1 for webhook routing
        try {
          await this.env.DB.prepare(
            'INSERT INTO chat_sessions (id, slack_thread_ts, status, ip_address, session_name) VALUES (?, ?, ?, ?, ?)'
          )
            .bind(this.chatState!.sessionId, result.ts, 'active', this.chatState!.ipAddress || null, this.chatState!.sessionName || null)
            .run();
        } catch (error) {
          console.error('[ChatSession] D1 insert error:', error);
        }
      } else {
        console.error('[ChatSession] Slack API error:', result.error);
      }
    } catch (error) {
      console.error('[ChatSession] Slack post error:', error);
    }
  }

  private async postToSlackThread(message: string): Promise<void> {
    if (!this.env.SLACK_BOT_TOKEN || !this.chatState?.slackThreadTs) return;

    try {
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: this.env.SLACK_CHANNEL_ID,
          thread_ts: this.chatState.slackThreadTs,
          text: message,
        }),
      });
    } catch (error) {
      console.error('[ChatSession] Slack thread post error:', error);
    }
  }

  private async createFreshdeskTicket(email: string): Promise<void> {
    if (!this.env.N8N_WEBHOOK_URL) {
      console.warn('[ChatSession] N8N_WEBHOOK_URL not configured');
      return;
    }

    // Compile chat transcript
    const roleLabels: Record<string, string> = {
      customer: 'Kunde',
      staff: 'Mitarbeiter',
      bot: 'Bot',
    };
    const transcript = this.chatState!.messages
      .map((m) => `[${roleLabels[m.role] || m.role}] ${m.content}`)
      .join('\n');

    try {
      const response = await fetch(this.env.N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          session_id: this.chatState!.sessionId,
          transcript,
          messages: this.chatState!.messages,
          visitor_info: this.chatState!.visitorInfo,
          country: this.chatState!.country,
          submitted_at: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('[ChatSession] n8n webhook error:', error);
      } else {
        console.log('[ChatSession] Ticket sent to n8n');
      }
    } catch (error) {
      console.error('[ChatSession] n8n webhook error:', error);
    }
  }

  private broadcast(message: WebSocketMessage): void {
    const data = JSON.stringify(message);
    for (const ws of this.websockets) {
      try {
        ws.send(data);
      } catch {
        // Socket may be closed
        this.websockets.delete(ws);
      }
    }
  }

  private broadcastExcept(excludeWs: WebSocket, message: WebSocketMessage): void {
    const data = JSON.stringify(message);
    for (const ws of this.websockets) {
      if (ws === excludeWs) continue;
      try {
        ws.send(data);
      } catch {
        // Socket may be closed
        this.websockets.delete(ws);
      }
    }
  }

  private sendToSocket(ws: WebSocket, message: WebSocketMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      this.websockets.delete(ws);
    }
  }

  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
}
