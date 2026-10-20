import type { Env, FileAttachment, SlackEventPayload, SlackMessageEvent } from './types';
import { ChatSession } from './ChatSession';
import { MAX_FILE_SIZE } from './config';
import { VISITOR_TEXTS } from './texts';
import {
  corsHeaders,
  isAllowedOrigin,
  isUuid,
  json,
  rateLimitKey,
  readBodyText,
  readJsonObject,
  sanitizeVisitorInfo,
  verifyTurnstile,
} from './http';
import { contentDisposition, contentMatchesType, fileKey, normalizeMimeType, sanitizeFilename } from './files';
import { getSlackUserName, isSlackFileUrl, verifySlackSignature } from './slack';

export { ChatSession };

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const { pathname } = url;
    const method = request.method;

    try {
      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
      }
      if (pathname === '/start' && method === 'POST') {
        return await handleStart(request, env, origin);
      }
      const connect = /^\/connect\/([^/]+)$/.exec(pathname);
      if (connect && method === 'GET') {
        return await handleConnect(request, env, connect[1], origin);
      }
      if (pathname === '/slack-webhook' && method === 'POST') {
        return await handleSlackWebhook(request, env, ctx);
      }
      if (pathname === '/upload/start' && method === 'POST') {
        return await handleUploadStart(request, env, origin);
      }
      if (pathname === '/upload/complete' && method === 'POST') {
        return await handleUploadComplete(request, env, ctx, origin, url);
      }
      const file = /^\/file\/([^/]+)\/([^/]+)$/.exec(pathname);
      if (file && method === 'GET') {
        return await handleFileDownload(env, file[1], file[2]);
      }
      if (pathname === '/health') {
        return new Response('OK');
      }
      if (pathname === '/demo' && env.ENABLE_DEMO_PAGE === 'true') {
        return demoPage(url, env);
      }
      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error(`[${pathname}] Unhandled error:`, error);
      return json({ error: 'Internal error' }, 500, corsHeaders(origin, env));
    }
  },
} satisfies ExportedHandler<Env>;

function sessionStub(env: Env, sessionId: string) {
  return env.CHAT_SESSION.get(env.CHAT_SESSION.idFromName(sessionId));
}

function websocketUrl(request: Request, sessionId: string): string {
  const url = new URL(request.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `/connect/${sessionId}`;
  url.search = '';
  return url.toString();
}

// POST /start: resume a chat, or open a new one (Turnstile + per-IP rate limit)
async function handleStart(request: Request, env: Env, origin: string | null): Promise<Response> {
  const cors = corsHeaders(origin, env);
  if (!isAllowedOrigin(origin, env)) {
    return json({ error: 'Origin not allowed' }, 403, cors);
  }
  const body = await readJsonObject(request, 16 * 1024);
  if (!body) {
    return json({ error: 'Invalid request' }, 400, cors);
  }
  const visitorInfo = sanitizeVisitorInfo(body.visitor);

  if (isUuid(body.sessionId) && (await sessionStub(env, body.sessionId).resume(visitorInfo))) {
    return json({ sessionId: body.sessionId, wsUrl: websocketUrl(request, body.sessionId), resumed: true }, 200, cors);
  }
  // The widget asks this way after a reload or reconnect; a new chat is only opened on purpose
  if (body.resumeOnly === true) {
    return json({ error: 'Chat not found or expired' }, 404, cors);
  }

  // Everything below creates a new chat, so it is where spam protection applies.
  // Requests without a token are turned away before they count against the rate limit.
  if (env.TURNSTILE_SECRET_KEY && !body.turnstile_token) {
    return json({ error: 'Turnstile token required' }, 400, cors);
  }
  if (!env.TURNSTILE_SECRET_KEY && env.DISABLE_TURNSTILE !== 'true') {
    // A forgotten secret must not silently switch the spam protection off
    console.error('[start] TURNSTILE_SECRET_KEY is not set. Set it, or set DISABLE_TURNSTILE to "true".');
    return json({ error: 'The chat is not configured yet' }, 503, cors);
  }
  const ip = request.headers.get('CF-Connecting-IP');
  if (env.START_LIMITER && ip) {
    const { success } = await env.START_LIMITER.limit({ key: rateLimitKey(ip) });
    if (!success) {
      return json({ error: 'Too many new chats. Please try again in a minute.' }, 429, cors);
    }
  }
  if (env.TURNSTILE_SECRET_KEY && !(await verifyTurnstile(body.turnstile_token, ip, env.TURNSTILE_SECRET_KEY))) {
    return json({ error: 'Turnstile verification failed' }, 403, cors);
  }

  const sessionId = crypto.randomUUID();
  await sessionStub(env, sessionId).init({
    sessionName: sessionId,
    visitorInfo,
    country: request.headers.get('CF-IPCountry') ?? undefined,
  });
  return json({ sessionId, wsUrl: websocketUrl(request, sessionId), resumed: false }, 200, cors);
}

// GET /connect/:sessionId: WebSocket to the chat's Durable Object
async function handleConnect(request: Request, env: Env, sessionId: string, origin: string | null): Promise<Response> {
  if (!isAllowedOrigin(origin, env)) {
    return new Response('Origin not allowed', { status: 403 });
  }
  if (!isUuid(sessionId)) {
    return new Response('Invalid session ID', { status: 400 });
  }
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 });
  }
  return sessionStub(env, sessionId).fetch(request);
}

// POST /slack-webhook: Slack Events API (thread replies from your team)
async function handleSlackWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.SLACK_SIGNING_SECRET) {
    console.error('[slack-webhook] SLACK_SIGNING_SECRET is not set, rejecting all Slack events');
    return new Response('Slack signing secret not configured', { status: 500 });
  }
  const body = await readBodyText(request, 1024 * 1024);
  if (body === null) {
    return new Response('Payload too large', { status: 413 });
  }
  if (!(await verifySlackSignature(request.headers, body, env.SLACK_SIGNING_SECRET))) {
    console.warn('[slack-webhook] Invalid signature');
    return new Response('Invalid signature', { status: 401 });
  }

  let payload: SlackEventPayload;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (payload.type === 'url_verification') {
    return new Response(payload.challenge ?? '', { headers: { 'Content-Type': 'text/plain' } });
  }
  const event = payload.event;
  const botUserId = payload.authorizations?.find((authorization) => authorization.is_bot)?.user_id;
  if (payload.type !== 'event_callback' || !event || !isStaffThreadReply(event, env, botUserId)) {
    return new Response('OK');
  }
  // Slack retries events it thinks we missed; handle each one once
  if (payload.event_id && !(await markEventProcessed(env, ctx, payload.event_id))) {
    return new Response('OK');
  }

  const session = await env.DB.prepare('SELECT id FROM chat_sessions WHERE slack_thread_ts = ?')
    .bind(event.thread_ts)
    .first<{ id: string }>();
  if (session) {
    // Answer Slack right away (it expects a response within 3 seconds) and deliver in the background
    ctx.waitUntil(forwardStaffReply(env, session.id, event));
  }
  return new Response('OK');
}

/**
 * A human reply inside a thread of the support channel. Replies starting with `//` are
 * internal notes for colleagues and stay in Slack. Messages of the app itself (visitor
 * messages, files it uploaded) are recognized by `bot_id` and by the bot's user ID.
 */
export function isStaffThreadReply(
  event: SlackMessageEvent,
  env: Pick<Env, 'SLACK_CHANNEL_ID'>,
  botUserId?: string
): boolean {
  // A channel name instead of an ID would never match; the chat also checks the thread's channel
  const channelMatches = !/^[CG][A-Z0-9]+$/.test(env.SLACK_CHANNEL_ID) || event.channel === env.SLACK_CHANNEL_ID;
  return (
    event.type === 'message' &&
    channelMatches &&
    !!event.thread_ts &&
    event.thread_ts !== event.ts &&
    !event.bot_id &&
    !!event.user &&
    event.user !== botUserId &&
    (event.subtype === undefined || event.subtype === 'file_share' || event.subtype === 'thread_broadcast') &&
    !/^\s*\/\//.test(event.text ?? '')
  );
}

async function markEventProcessed(env: Env, ctx: ExecutionContext, eventId: string): Promise<boolean> {
  try {
    const result = await env.DB.prepare('INSERT OR IGNORE INTO processed_events (event_id) VALUES (?)')
      .bind(eventId)
      .run();
    ctx.waitUntil(env.DB.prepare("DELETE FROM processed_events WHERE processed_at < datetime('now', '-1 hour')").run());
    return result.meta.changes > 0;
  } catch (error) {
    console.error('[slack-webhook] Deduplication failed:', error);
    return true;
  }
}

async function forwardStaffReply(env: Env, durableObjectId: string, event: SlackMessageEvent): Promise<void> {
  try {
    const staffName = await getSlackUserName(env, event.user!);
    const files = (event.files ?? []).filter((file) => isSlackFileUrl(file.url_private));
    const stub = env.CHAT_SESSION.get(env.CHAT_SESSION.idFromString(durableObjectId));
    await stub.staffReply({ text: event.text ?? '', staffName, files, channel: event.channel });
  } catch (error) {
    console.error('[slack-webhook] Delivering a staff reply failed:', error);
  }
}

// POST /upload/start: reserve an upload (type, size and per-chat limits are checked here)
async function handleUploadStart(request: Request, env: Env, origin: string | null): Promise<Response> {
  const cors = corsHeaders(origin, env);
  if (!isAllowedOrigin(origin, env)) {
    return json({ error: 'Origin not allowed' }, 403, cors);
  }
  const body = await readJsonObject(request, 4096);
  if (!body || !isUuid(body.sessionId) || typeof body.filename !== 'string' || typeof body.size !== 'number') {
    return json({ error: 'Missing required fields' }, 400, cors);
  }
  const mimeType = normalizeMimeType(body.mimeType);
  if (!mimeType) {
    return json({ error: VISITOR_TEXTS.fileTypeNotAllowed }, 400, cors);
  }
  if (!(body.size > 0) || body.size > MAX_FILE_SIZE) {
    return json({ error: VISITOR_TEXTS.fileTooLarge }, 400, cors);
  }

  const result = await sessionStub(env, body.sessionId).reserveUpload({
    name: sanitizeFilename(body.filename, mimeType),
    mimeType,
    size: body.size,
  });
  if ('error' in result) {
    return json({ error: result.error }, result.status, cors);
  }
  return json({ fileId: result.fileId, expiresAt: result.expiresAt, maxSize: MAX_FILE_SIZE }, 200, cors);
}

// POST /upload/complete?sessionId=…&fileId=…: the file itself as the request body
async function handleUploadComplete(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  origin: string | null,
  url: URL
): Promise<Response> {
  const cors = corsHeaders(origin, env);
  if (!isAllowedOrigin(origin, env)) {
    return json({ error: 'Origin not allowed' }, 403, cors);
  }
  const sessionId = url.searchParams.get('sessionId');
  const fileId = url.searchParams.get('fileId');
  if (!isUuid(sessionId) || !isUuid(fileId) || !request.body) {
    return json({ error: 'Missing required fields' }, 400, cors);
  }
  const length = Number(request.headers.get('Content-Length'));
  if (!length) {
    return json({ error: 'Content-Length required' }, 411, cors);
  }
  if (length > MAX_FILE_SIZE) {
    return json({ error: VISITOR_TEXTS.fileTooLarge }, 413, cors);
  }

  // Redeem the reservation before reading the body, so nobody can make the Worker hold files it never asked for
  const stub = sessionStub(env, sessionId);
  const pending = await stub.claimUpload(fileId);
  if (!pending) {
    return json({ error: 'Upload expired or not found' }, 400, cors);
  }
  if (length !== pending.size) {
    return json({ error: 'File size does not match' }, 400, cors);
  }

  // Streamed straight into R2; the content check then reads back only the first bytes
  const key = fileKey(sessionId, fileId);
  await env.FILES_BUCKET.put(key, request.body, {
    httpMetadata: { contentType: pending.mimeType, contentDisposition: contentDisposition(pending.name) },
    customMetadata: { source: 'visitor' },
  });
  const head = await env.FILES_BUCKET.get(key, { range: { offset: 0, length: 4096 } });
  if (!head || !contentMatchesType(pending.mimeType, new Uint8Array(await head.arrayBuffer()))) {
    await env.FILES_BUCKET.delete(key);
    return json({ error: VISITOR_TEXTS.fileContentMismatch }, 400, cors);
  }

  const attachment: FileAttachment = {
    id: fileId,
    name: pending.name,
    mimeType: pending.mimeType,
    size: length,
    url: `/file/${sessionId}/${fileId}`,
  };
  // Shows the file in the chat and forwards it to Slack after we have answered
  ctx.waitUntil(stub.addVisitorFile(attachment, key));
  return json({ success: true, attachment }, 200, cors);
}

// GET /file/:sessionId/:fileId: download, for as long as the chat can be resumed
async function handleFileDownload(env: Env, sessionId: string, fileId: string): Promise<Response> {
  if (!isUuid(sessionId) || !isUuid(fileId)) {
    return new Response('Not Found', { status: 404 });
  }
  const key = await sessionStub(env, sessionId).getFileKey(fileId);
  const object = key ? await env.FILES_BUCKET.get(key) : null;
  if (!object) {
    return new Response('Not Found', { status: 404 });
  }
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'Content-Disposition': object.httpMetadata?.contentDisposition ?? 'attachment',
      'Content-Length': String(object.size),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

// GET /demo: local test page (only when ENABLE_DEMO_PAGE is "true")
function demoPage(url: URL, env: Env): Response {
  const escape = (value: string) =>
    value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const siteKey = env.TURNSTILE_SITE_KEY ? ` data-turnstile-site-key="${escape(env.TURNSTILE_SITE_KEY)}"` : '';
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Live chat demo</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5">
<h1>Live chat demo</h1>
<p>The bubble in the corner talks to this Worker. <code>${escape(url.origin)}</code> must be listed in <code>ALLOWED_ORIGINS</code>.</p>
<script src="/widget.js"${siteKey} defer></script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
