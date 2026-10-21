import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import worker from '../src/index';
import { DELIVERY_RETRY_DELAYS_MS, SESSION_RESUME_TTL_MS, SESSION_RETENTION_MS, STAGE_1_DELAY_MS } from '../src/config';
import type { ChatState, ServerMessage } from '../src/types';
import { ORIGIN, mockOutboundFetch, signSlackBody, slackCalls, waitFor } from './helpers';

const BASE = 'https://chat.example.workers.dev';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
let ipCounter = 0;

afterEach(() => {
  vi.restoreAllMocks();
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return exports.default.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function start(body: Record<string, unknown>, origin = ORIGIN, ip = `203.0.113.${++ipCounter % 250}`) {
  return post('/start', body, { Origin: origin, 'CF-Connecting-IP': ip });
}

async function newChat(): Promise<string> {
  const response = await start({
    turnstile_token: 'valid-token',
    visitor: { pageUrl: 'https://example.com/pricing', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0' },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { sessionId: string }).sessionId;
}

async function connect(sessionId: string) {
  const response = await exports.default.fetch(`${BASE}/connect/${sessionId}`, {
    headers: { Upgrade: 'websocket', Origin: ORIGIN },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const received: ServerMessage[] = [];
  const closed: { code?: number } = {};
  ws.addEventListener('message', (event) => {
    received.push(JSON.parse(event.data as string));
  });
  ws.addEventListener('close', (event) => {
    closed.code = event.code;
  });
  ws.accept();
  return { ws, received, closed };
}

function stub(sessionId: string) {
  return env.CHAT_SESSION.get(env.CHAT_SESSION.idFromName(sessionId));
}

/** Changes the stored chat (e.g. to move it back in time) and returns the result. */
async function editChat(sessionId: string, edit: (chat: ChatState) => void): Promise<void> {
  await runInDurableObject(stub(sessionId), async (instance, state) => {
    const holder = instance as unknown as { chat: ChatState };
    edit(holder.chat);
    await state.storage.put('chatState', holder.chat);
  });
}

/** A copy of the chat's current state. */
function readChat(sessionId: string): Promise<ChatState> {
  return runInDurableObject(stub(sessionId), (instance) =>
    structuredClone((instance as unknown as { chat: ChatState }).chat)
  );
}

/** Runs the chat's alarm as if the delivery retry were due now. */
async function runDeliveryRetry(sessionId: string): Promise<void> {
  await editChat(sessionId, (chat) => {
    chat.deliveryRetryAt = Date.now() - 1;
  });
  expect(await runDurableObjectAlarm(stub(sessionId))).toBe(true);
}

async function slackEvent(event: Record<string, unknown>, eventId = crypto.randomUUID()) {
  const body = JSON.stringify({ type: 'event_callback', event_id: eventId, event });
  const headers = await signSlackBody(body, 'test-signing-secret');
  return exports.default.fetch(`${BASE}/slack-webhook`, { method: 'POST', headers, body });
}

function sendFile(sessionId: string, fileId: string, bytes: Uint8Array, mimeType: string) {
  return exports.default.fetch(`${BASE}/upload/complete?sessionId=${sessionId}&fileId=${fileId}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': mimeType, 'Content-Length': String(bytes.byteLength) },
    body: bytes,
  });
}

async function upload(sessionId: string, bytes: Uint8Array, filename: string, mimeType: string) {
  const reservation = await post('/upload/start', { sessionId, filename, mimeType, size: bytes.byteLength });
  if (reservation.status !== 200) return reservation;
  const { fileId } = (await reservation.json()) as { fileId: string };
  return sendFile(sessionId, fileId, bytes, mimeType);
}

describe('POST /start', () => {
  it('rejects origins that are not listed exactly', async () => {
    mockOutboundFetch();
    expect((await start({ turnstile_token: 'valid-token' }, 'https://localhost.evil.example')).status).toBe(403);
    expect((await start({ turnstile_token: 'valid-token' }, 'https://example.com.evil.example')).status).toBe(403);
  });

  it('requires a valid Turnstile token for a new chat', async () => {
    mockOutboundFetch();
    expect((await start({})).status).toBe(400);
    expect((await start({ turnstile_token: 'forged' })).status).toBe(403);
  });

  it('refuses new chats when the Turnstile secret is missing, unless explicitly disabled', async () => {
    mockOutboundFetch();
    const request = () =>
      new Request(`${BASE}/start`, { method: 'POST', headers: { Origin: ORIGIN }, body: JSON.stringify({}) });
    const withoutSecret = { ...env, TURNSTILE_SECRET_KEY: undefined };
    expect((await worker.fetch(request() as never, withoutSecret, createExecutionContext())).status).toBe(503);
    const disabled = { ...withoutSecret, DISABLE_TURNSTILE: 'true' };
    expect((await worker.fetch(request() as never, disabled, createExecutionContext())).status).toBe(200);
  });

  it('cannot be tricked into skipping Turnstile with an unknown session ID', async () => {
    mockOutboundFetch();
    expect((await start({ sessionId: crypto.randomUUID() })).status).toBe(400);
  });

  it('answers resume-only requests for unknown chats with 404 and never opens a chat for them', async () => {
    mockOutboundFetch();
    const response = await start({ sessionId: crypto.randomUUID(), resumeOnly: true, turnstile_token: 'valid-token' });
    expect(response.status).toBe(404);
  });

  it('does not count failed resumes or requests without a token against the rate limit', async () => {
    mockOutboundFetch();
    const ip = '198.51.100.99';
    for (let i = 0; i < 4; i++) {
      expect((await start({ sessionId: crypto.randomUUID(), resumeOnly: true }, ORIGIN, ip)).status).toBe(404);
      expect((await start({}, ORIGIN, ip)).status).toBe(400);
    }
    expect((await start({ turnstile_token: 'valid-token' }, ORIGIN, ip)).status).toBe(200);
  });

  it('resumes an existing chat without a new token', async () => {
    mockOutboundFetch();
    const sessionId = await newChat();
    const response = await start({ sessionId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessionId, resumed: true });
  });

  it('limits how many chats one IP address can open per minute', async () => {
    mockOutboundFetch();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await start({ turnstile_token: 'valid-token' }, ORIGIN, '198.51.100.7')).status);
    expect(statuses).toContain(429);
  });
});

describe('GET /connect/:sessionId', () => {
  it('does not create a chat for an unknown ID', async () => {
    const response = await exports.default.fetch(`${BASE}/connect/${crypto.randomUUID()}`, {
      headers: { Upgrade: 'websocket', Origin: ORIGIN },
    });
    expect(response.status).toBe(404);
  });

  it('rejects malformed IDs and other origins', async () => {
    const headers = { Upgrade: 'websocket', Origin: ORIGIN };
    expect((await exports.default.fetch(`${BASE}/connect/../../x`, { headers })).status).toBe(404);
    expect((await exports.default.fetch(`${BASE}/connect/not-a-uuid`, { headers })).status).toBe(400);
    const foreign = { ...headers, Origin: 'https://evil.example' };
    expect((await exports.default.fetch(`${BASE}/connect/${crypto.randomUUID()}`, { headers: foreign })).status).toBe(403);
  });
});

describe('chat flow', () => {
  it('posts visitor messages to one Slack thread, escaped', async () => {
    const calls = mockOutboundFetch();
    const sessionId = await newChat();
    const { ws, received } = await connect(sessionId);

    ws.send(JSON.stringify({ type: 'message', content: 'Hello <!channel>', clientId: 'local-1' }));
    ws.send(JSON.stringify({ type: 'message', content: 'second\nline' }));
    await waitFor(() => slackCalls(calls, 'chat.postMessage').length >= 2);

    const [parent, reply] = slackCalls(calls, 'chat.postMessage');
    expect(parent.body.thread_ts).toBeUndefined();
    expect(parent.body.text).toContain('> Hello &lt;!channel&gt;');
    expect(parent.body.text).toContain('*Page*: /pricing');
    expect(parent.headers.get('Authorization')).toBe('Bearer xoxb-test');
    expect(reply.body).toMatchObject({ thread_ts: parent.ts, text: '> second\n> line' });
    expect(received).toContainEqual({ type: 'message_ack', payload: { id: expect.any(String), clientId: 'local-1' } });

    const row = await env.DB.prepare('SELECT * FROM chat_sessions WHERE slack_thread_ts = ?')
      .bind(parent.ts)
      .first<{ session_name: string; ip_address: string | null }>();
    expect(row).toMatchObject({ session_name: sessionId, ip_address: null });

    // After a reconnect the widget recognizes its own messages by their client ID
    const again = await connect(sessionId);
    await waitFor(() => again.received.some((m) => m.type === 'status'));
    const status = again.received.find((m) => m.type === 'status')!;
    expect(status.type === 'status' && status.payload.messages?.[0].clientId).toBe('local-1');
  });

  it('keeps posting to Slack when Slack refuses a file', async () => {
    const calls = mockOutboundFetch({ fileUploadFails: true });
    const sessionId = await newChat();
    const { ws } = await connect(sessionId);
    expect((await upload(sessionId, PNG, 'photo.png', 'image/png')).status).toBe(200);
    await waitFor(() => slackCalls(calls, 'chat.postMessage').length === 2);
    ws.send(JSON.stringify({ type: 'message', content: 'Did you get my screenshot?' }));
    await waitFor(() => slackCalls(calls, 'chat.postMessage').length === 3);

    const [parent, notice, text] = slackCalls(calls, 'chat.postMessage');
    expect(parent.body.text).toContain('[File: photo.png]');
    expect(notice.body.text).toContain('could not be uploaded');
    expect(text.body.text).toBe('> Did you get my screenshot?');
  });

  it('falls back to the automatic replies when the bot is switched off during a chat', async () => {
    mockOutboundFetch();
    const sessionId = await newChat();
    const { ws } = await connect(sessionId);
    ws.send(JSON.stringify({ type: 'message', content: 'Hello' }));
    let first = 0;
    await waitFor(async () => {
      first = await runInDurableObject(stub(sessionId), (i) => (i as unknown as { chat: ChatState }).chat.firstCustomerMessageAt ?? 0);
      return first > 0;
    });
    // Pretend the chat started while the bot was on: no waiting messages scheduled
    await editChat(sessionId, (chat) => {
      chat.botActive = true;
    });
    await runInDurableObject(stub(sessionId), (_, state) => state.storage.setAlarm(Date.now() + SESSION_RETENTION_MS));

    await evictDurableObject(stub(sessionId));
    const [botActive, alarm] = await runInDurableObject(stub(sessionId), async (instance, state) => [
      (instance as unknown as { chat: ChatState }).chat.botActive,
      await state.storage.getAlarm(),
    ]);
    expect(botActive).toBe(false);
    expect(alarm).toBe(first + STAGE_1_DELAY_MS);
  });

  it('retries the Slack thread on the next message when Slack was down', async () => {
    let calls = mockOutboundFetch({ slackDown: true });
    const sessionId = await newChat();
    const { ws } = await connect(sessionId);
    ws.send(JSON.stringify({ type: 'message', content: 'first' }));
    await waitFor(() => slackCalls(calls, 'chat.postMessage').length === 1);

    vi.restoreAllMocks();
    calls = mockOutboundFetch();
    ws.send(JSON.stringify({ type: 'message', content: 'second' }));
    await waitFor(() => slackCalls(calls, 'chat.postMessage').length === 2);
    const [parent, reply] = slackCalls(calls, 'chat.postMessage');
    expect(parent.body.text).toContain('> first');
    expect(reply.body).toMatchObject({ text: '> second', thread_ts: parent.ts });
  });

  it('keeps the message rate limit across hibernation and closes floods of frames', async () => {
    mockOutboundFetch();
    const sessionId = await newChat();
    let { ws, received } = await connect(sessionId);
    for (let i = 0; i < 10; i++) ws.send(JSON.stringify({ type: 'message', content: `message ${i}` }));
    await waitFor(() => received.filter((m) => m.type === 'message_ack').length === 10);

    await evictDurableObject(stub(sessionId));
    ws.send(JSON.stringify({ type: 'message', content: 'one too many' }));
    await waitFor(() => received.some((m) => m.type === 'error'));

    const second = await connect(sessionId);
    for (let i = 0; i < 70; i++) second.ws.send(JSON.stringify({ type: 'pong' }));
    await waitFor(() => second.closed.code === 1008);
  });

  it('retries Slack posts and notices with the alarm until Slack accepts them', async () => {
    let calls = mockOutboundFetch({ slackDown: true });
    const sessionId = await newChat();
    const { ws, received } = await connect(sessionId);
    ws.send(JSON.stringify({ type: 'message', content: 'Hello?' }));
    await waitFor(async () => (await readChat(sessionId)).deliveryAttempts === 1);
    ws.send(JSON.stringify({ type: 'email', email: 'me@example.com' }));
    await waitFor(() => received.some((m) => m.type === 'status' && m.payload.status === 'ended'));

    let chat = await readChat(sessionId);
    expect(chat.slackOutbox).toHaveLength(1);
    expect(chat.deliveryRetryAt).toBeGreaterThan(Date.now());
    expect(slackCalls(calls, 'chat.postMessage').length).toBeGreaterThan(0); // all of them failed

    vi.restoreAllMocks();
    calls = mockOutboundFetch();
    await runDeliveryRetry(sessionId);
    await waitFor(() => slackCalls(calls, 'chat.postMessage').length === 2);
    const [parent, notice] = slackCalls(calls, 'chat.postMessage');
    expect(parent.body.text).toContain('> Hello?');
    expect(notice.body).toMatchObject({ thread_ts: parent.ts });
    expect(notice.body.text).toContain('me@example.com');

    chat = await readChat(sessionId);
    expect(chat).toMatchObject({ slackOutbox: [], deliveryAttempts: 0, routingSaved: true });
    expect(chat.deliveryRetryAt).toBeUndefined();
  });

  it('stops retrying after the last delay', async () => {
    mockOutboundFetch({ slackDown: true });
    const sessionId = await newChat();
    const { ws } = await connect(sessionId);
    ws.send(JSON.stringify({ type: 'message', content: 'Hello?' }));
    await waitFor(async () => (await readChat(sessionId)).deliveryAttempts === 1);
    expect((await readChat(sessionId)).deliveryRetryAt).toBeDefined();

    await editChat(sessionId, (chat) => {
      chat.deliveryAttempts = DELIVERY_RETRY_DELAYS_MS.length;
    });
    await runDeliveryRetry(sessionId);
    await waitFor(async () => (await readChat(sessionId)).deliveryAttempts === DELIVERY_RETRY_DELAYS_MS.length + 1);
    expect((await readChat(sessionId)).deliveryRetryAt).toBeUndefined();
  });

  it('saves the Slack routing row later when D1 fails at first, without posting the thread twice', async () => {
    const calls = mockOutboundFetch();
    const sessionId = await newChat();
    const { ws } = await connect(sessionId);
    await env.DB.exec('ALTER TABLE chat_sessions RENAME TO chat_sessions_offline');
    try {
      ws.send(JSON.stringify({ type: 'message', content: 'Hello' }));
      await waitFor(async () => (await readChat(sessionId)).deliveryAttempts === 1, 5000);
    } finally {
      await env.DB.exec('ALTER TABLE chat_sessions_offline RENAME TO chat_sessions');
    }
    expect((await readChat(sessionId)).routingSaved).toBe(false);

    await runDeliveryRetry(sessionId);
    await waitFor(async () => (await readChat(sessionId)).routingSaved);
    const [parent] = slackCalls(calls, 'chat.postMessage');
    const row = await env.DB.prepare('SELECT session_name FROM chat_sessions WHERE slack_thread_ts = ?')
      .bind(parent.ts)
      .first();
    expect(row).toMatchObject({ session_name: sessionId });
    expect(slackCalls(calls, 'chat.postMessage')).toHaveLength(1);
  });

  it('sends the waiting messages, escalates once, then only schedules the cleanup', async () => {
    const calls = mockOutboundFetch();
    const sessionId = await newChat();
    const { ws, received } = await connect(sessionId);
    ws.send(JSON.stringify({ type: 'message', content: 'Anyone there?' }));
    await waitFor(() => slackCalls(calls, 'chat.postMessage').length === 1);

    let createdAt = 0;
    await editChat(sessionId, (chat) => {
      chat.firstCustomerMessageAt! -= 60_000;
      createdAt = chat.createdAt;
    });
    expect(await runDurableObjectAlarm(stub(sessionId))).toBe(true);

    await waitFor(() => received.some((m) => m.type === 'status' && m.payload.status === 'escalated'));
    const autoReplies = received.filter((m) => m.type === 'message' && m.payload.role === 'bot');
    expect(autoReplies).toHaveLength(2);
    const alarm = await runInDurableObject(stub(sessionId), (_, state) => state.storage.getAlarm());
    expect(alarm).toBe(createdAt + SESSION_RETENTION_MS);
  });

  it('delivers staff replies once, as plain text, and stops the automatic messages', async () => {
    const calls = mockOutboundFetch();
    const sessionId = await newChat();
    const { ws, received } = await connect(sessionId);
    ws.send(JSON.stringify({ type: 'message', content: 'Hi' }));
    await waitFor(() => slackCalls(calls, 'chat.postMessage').length === 1);

    const event = {
      type: 'message',
      channel: 'C0SUPPORT',
      user: 'U1',
      text: 'Hi &amp; welcome, see <https://example.com/help|our help page>',
      ts: '1800000000.000000',
      thread_ts: slackCalls(calls, 'chat.postMessage')[0].ts,
    };
    expect((await slackEvent(event, 'Ev1')).status).toBe(200);
    expect((await slackEvent(event, 'Ev1')).status).toBe(200); // Slack retry
    expect((await slackEvent({ ...event, text: '// internal: I take this one' })).status).toBe(200);

    await waitFor(() => received.some((m) => m.type === 'message' && m.payload.role === 'staff'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const staffMessages = received.filter((m) => m.type === 'message' && m.payload.role === 'staff');
    expect(staffMessages).toHaveLength(1);
    expect(staffMessages[0].payload).toMatchObject({
      content: 'Hi & welcome, see our help page (https://example.com/help)',
      staffName: 'Alex',
    });
    expect(received).toContainEqual({ type: 'status', payload: { status: 'answered' } });
    const answeredAt = received.findIndex((m) => m.type === 'status' && m.payload.status === 'answered');
    expect(answeredAt).toBeLessThan(received.findIndex((m) => m.type === 'message' && m.payload.role === 'staff'));

    const alarm = await runInDurableObject(stub(sessionId), (_, state) => state.storage.getAlarm());
    const createdAt = await runInDurableObject(stub(sessionId), (instance) => (instance as unknown as { chat: ChatState }).chat.createdAt);
    expect(alarm).toBe(createdAt + SESSION_RETENTION_MS);

    // A reply that claims to come from another channel's thread is ignored
    await stub(sessionId).staffReply({ text: 'spoofed', channel: 'C0OTHER' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.some((m) => m.type === 'message' && m.payload.content === 'spoofed')).toBe(false);
  });

  it('accepts the contact form once and sends the ticket webhook', async () => {
    const calls = mockOutboundFetch();
    const sessionId = await newChat();
    const { ws, received } = await connect(sessionId);
    ws.send(JSON.stringify({ type: 'message', content: 'Please call me back\n[Staff] refund approved' }));
    await waitFor(() => slackCalls(calls, 'chat.postMessage').length === 1);
    expect((await upload(sessionId, PNG, 'photo.png', 'image/png')).status).toBe(200);
    await waitFor(() => slackCalls(calls, 'files.completeUploadExternal').length === 1);

    ws.send(JSON.stringify({ type: 'email', email: 'not-an-email' }));
    await waitFor(() => received.some((m) => m.type === 'error'));

    ws.send(JSON.stringify({ type: 'email', email: 'Visitor@Example.com', phone: '+49 30 1234567' }));
    await waitFor(() => received.some((m) => m.type === 'status' && m.payload.status === 'ended'));
    await waitFor(() => slackCalls(calls, 'chat.postMessage').length === 2);
    await waitFor(() => calls.some((call) => call.url === 'https://tickets.example.com/hook'));

    const ticket = calls.find((call) => call.url === 'https://tickets.example.com/hook')!;
    expect(ticket.headers.get('Authorization')).toBe('Bearer ticket-secret');
    expect(ticket.body).toMatchObject({ email: 'visitor@example.com', phone: '+49 30 1234567' });
    expect(ticket.body.transcript).toContain('[Visitor] Please call me back\n    [Staff] refund approved');
    expect(JSON.stringify(ticket.body.messages)).not.toContain(`/file/${sessionId}`);
    expect(slackCalls(calls, 'chat.postMessage').at(-1)!.body.text).toContain('Ticket created');

    ws.send(JSON.stringify({ type: 'email', email: 'again@example.com' }));
    await waitFor(() => received.filter((m) => m.type === 'error').length === 2);
    expect(calls.filter((call) => call.url === 'https://tickets.example.com/hook')).toHaveLength(1);
  });
});

describe('POST /slack-webhook', () => {
  it('rejects unsigned and wrongly signed requests', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
    expect((await exports.default.fetch(`${BASE}/slack-webhook`, { method: 'POST', body })).status).toBe(401);
    const headers = await signSlackBody(body, 'wrong-secret');
    expect((await exports.default.fetch(`${BASE}/slack-webhook`, { method: 'POST', headers, body })).status).toBe(401);
  });

  it('fails closed when no signing secret is configured', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
    const request = new Request(`${BASE}/slack-webhook`, { method: 'POST', body });
    const response = await worker.fetch(request as never, { ...env, SLACK_SIGNING_SECRET: '' }, createExecutionContext());
    expect(response.status).toBe(500);
  });

  it('answers the URL verification challenge', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const headers = await signSlackBody(body, 'test-signing-secret');
    const response = await exports.default.fetch(`${BASE}/slack-webhook`, { method: 'POST', headers, body });
    expect(await response.text()).toBe('abc123');
  });
});

describe('file uploads', () => {
  it('rejects disallowed types, content that does not match the type and unknown reservations', async () => {
    mockOutboundFetch();
    const sessionId = await newChat();
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    expect((await upload(sessionId, html, 'page.html', 'text/html')).status).toBe(400);
    expect((await upload(sessionId, html, 'cat.png', 'image/png')).status).toBe(400);
    expect((await sendFile(sessionId, crypto.randomUUID(), PNG, 'image/png')).status).toBe(400);

    const reservation = await post('/upload/start', { sessionId, filename: 'a.png', mimeType: 'image/png', size: 4 });
    const { fileId } = (await reservation.json()) as { fileId: string };
    expect((await sendFile(sessionId, fileId, PNG, 'image/png')).status).toBe(400); // larger than reserved
    expect((await sendFile(sessionId, fileId, PNG.slice(0, 4), 'image/png')).status).toBe(400); // reservation used up
  });

  it('stores a valid file, shows it in the chat, forwards it to Slack and serves it safely', async () => {
    const calls = mockOutboundFetch();
    const sessionId = await newChat();
    const { received } = await connect(sessionId);

    const response = await upload(sessionId, PNG, 'Screenshot März.png', 'image/png');
    expect(response.status).toBe(200);
    const { attachment } = (await response.json()) as { attachment: { url: string; name: string } };
    expect(attachment.name).toBe('Screenshot März.png');

    await waitFor(() => received.some((m) => m.type === 'message' && !!m.payload.attachments?.length));
    await waitFor(() => slackCalls(calls, 'files.completeUploadExternal').length === 1);

    const download = await exports.default.fetch(`${BASE}${attachment.url}`);
    expect(download.status).toBe(200);
    expect(download.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(download.headers.get('Content-Disposition')).toContain("filename*=UTF-8''Screenshot%20M%C3%A4rz.png");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(PNG);

    const unknown = await exports.default.fetch(`${BASE}/file/${sessionId}/${crypto.randomUUID()}`);
    expect(unknown.status).toBe(404);
  });
});

describe('retention', () => {
  it('deletes chats nobody wrote in once they can no longer be resumed', async () => {
    mockOutboundFetch();
    const sessionId = await newChat();
    const [alarm, createdAt] = await runInDurableObject(stub(sessionId), async (instance, state) => [
      await state.storage.getAlarm(),
      (instance as unknown as { chat: ChatState }).chat.createdAt,
    ]);
    expect(alarm).toBe(createdAt + SESSION_RESUME_TTL_MS);
  });

  it('deletes the transcript, files and Slack routing row after the retention period', async () => {
    const calls = mockOutboundFetch();
    const sessionId = await newChat();
    const { ws, received } = await connect(sessionId);
    ws.send(JSON.stringify({ type: 'message', content: 'Hello' }));
    await waitFor(() => slackCalls(calls, 'chat.postMessage').length === 1);
    expect((await upload(sessionId, PNG, 'a.png', 'image/png')).status).toBe(200);

    let fileKeys: string[] = [];
    await waitFor(async () => {
      fileKeys = await runInDurableObject(stub(sessionId), (instance) =>
        Object.values((instance as unknown as { chat: ChatState }).chat.files)
      );
      return fileKeys.length === 1;
    });

    await editChat(sessionId, (chat) => {
      chat.createdAt -= SESSION_RETENTION_MS + 1000;
    });
    expect(await runDurableObjectAlarm(stub(sessionId))).toBe(true);

    expect(await env.FILES_BUCKET.head(fileKeys[0])).toBeNull();
    const row = await env.DB.prepare('SELECT id FROM chat_sessions WHERE session_name = ?').bind(sessionId).first();
    expect(row).toBeNull();
    const stored = await runInDurableObject(stub(sessionId), (_, state) => state.storage.list());
    expect(stored.size).toBe(0);
    expect(received).toContainEqual({ type: 'status', payload: { status: 'ended', message: 'This chat has expired.' } });
  });

  it('deletes a file that finished uploading after its chat was deleted', async () => {
    const sessionId = crypto.randomUUID();
    const fileId = crypto.randomUUID();
    const key = `${sessionId}/${fileId}`;
    await env.FILES_BUCKET.put(key, PNG);
    await stub(sessionId).addVisitorFile(
      { id: fileId, name: 'late.png', mimeType: 'image/png', size: PNG.byteLength, url: `/file/${key}` },
      key
    );
    expect(await env.FILES_BUCKET.head(key)).toBeNull();
  });
});
