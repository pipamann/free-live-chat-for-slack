import type { Env, SlackEventPayload, VisitorInfo, ChatState, FileAttachment, SlackFile } from './types';

export { ChatSession } from './ChatSession';

// File upload constraints
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
const PRESIGNED_URL_EXPIRY = 5 * 60; // 5 minutes

// Sanitize filename - remove path traversal and dangerous characters
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[\/\\]/g, '') // Remove path separators
    .replace(/\.\./g, '') // Remove parent directory references
    .replace(/[<>:"|?*]/g, '') // Remove Windows-forbidden chars
    .slice(0, 255); // Limit length
}

// SSRF validation - only allow Slack file URLs
function isValidSlackFileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['files.slack.com', 'files-origin.slack.com'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

// CORS headers for cross-origin requests
function corsHeaders(origin: string | null, env: Env): HeadersInit {
  const allowedOrigins = env.ALLOWED_ORIGINS?.split(',') || [];
  const isAllowed = origin && (allowedOrigins.includes(origin) || origin.includes('localhost'));

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// Verify Slack request signature
async function verifySlackSignature(
  request: Request,
  body: string,
  signingSecret: string
): Promise<boolean> {
  const timestamp = request.headers.get('X-Slack-Request-Timestamp');
  const signature = request.headers.get('X-Slack-Signature');

  if (!timestamp || !signature) return false;

  // Check timestamp is recent (within 5 minutes)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  // Compute expected signature
  const sigBaseString = `v0:${timestamp}:${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(sigBaseString));
  const expectedSignature =
    'v0=' +
    Array.from(new Uint8Array(signatureBytes))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  return signature === expectedSignature;
}

// Verify Turnstile token
async function verifyTurnstile(
  token: string,
  ip: string,
  secret: string
): Promise<boolean> {
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret,
        response: token,
        remoteip: ip,
      }),
    });
    const result = (await response.json()) as { success: boolean };
    return result.success;
  } catch {
    return false;
  }
}

// Get user info from Slack
async function getSlackUserName(userId: string, token: string): Promise<string | undefined> {
  try {
    const response = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = (await response.json()) as {
      ok: boolean;
      user?: { real_name?: string; profile?: { display_name?: string } };
    };
    if (result.ok && result.user) {
      return result.user.real_name || result.user.profile?.display_name;
    }
  } catch {
    // Ignore errors
  }
  return undefined;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, env),
      });
    }

    // Route: POST /start - Create new chat session
    if (url.pathname === '/start' && request.method === 'POST') {
      return handleStart(request, env, origin);
    }

    // Route: GET /connect/:sessionId - WebSocket upgrade
    if (url.pathname.startsWith('/connect/') && request.method === 'GET') {
      const sessionId = url.pathname.split('/')[2];
      return handleConnect(request, env, sessionId);
    }

    // Route: POST /slack-webhook - Slack Events API
    if (url.pathname === '/slack-webhook' && request.method === 'POST') {
      return handleSlackWebhook(request, env, ctx);
    }

    // Route: POST /upload/start - Request presigned URL for file upload
    if (url.pathname === '/upload/start' && request.method === 'POST') {
      return handleUploadStart(request, env, origin);
    }

    // Route: POST /upload/complete - Finalize file upload
    if (url.pathname === '/upload/complete' && request.method === 'POST') {
      return handleUploadComplete(request, env, ctx, origin);
    }

    // Route: GET /file/:sessionId/:fileId - Download file
    if (url.pathname.startsWith('/file/') && request.method === 'GET') {
      const parts = url.pathname.split('/');
      if (parts.length === 4) {
        const sessionId = parts[2];
        const fileId = parts[3];
        return handleFileDownload(request, env, sessionId, fileId, origin);
      }
    }

    // Route: GET /health - Health check
    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },
};

// Session TTL for resumption (24 hours)
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

async function handleStart(request: Request, env: Env, origin: string | null): Promise<Response> {
  const headers = corsHeaders(origin, env);

  // Validate origin before processing (security: CORS is not authorization)
  const allowedOrigins = env.ALLOWED_ORIGINS?.split(',') || [];
  const isAllowedOrigin = origin && (allowedOrigins.includes(origin) || origin.includes('localhost'));
  if (!isAllowedOrigin) {
    return new Response(JSON.stringify({ error: 'Invalid origin' }), {
      status: 403,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = (await request.json()) as {
      turnstile_token?: string;
      sessionId?: string;
      visitor?: VisitorInfo;
    };

    // Verify Turnstile if configured (only for new sessions, not resumes)
    if (env.TURNSTILE_SECRET_KEY && !body.sessionId) {
      if (!body.turnstile_token) {
        return new Response(JSON.stringify({ error: 'Turnstile token required' }), {
          status: 400,
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      const clientIp = request.headers.get('CF-Connecting-IP') || '';
      const isValid = await verifyTurnstile(body.turnstile_token, clientIp, env.TURNSTILE_SECRET_KEY);
      if (!isValid) {
        return new Response(JSON.stringify({ error: 'Turnstile verification failed' }), {
          status: 400,
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
    }

    const clientIp = request.headers.get('CF-Connecting-IP') || '';
    const country = request.headers.get('CF-IPCountry') || undefined;

    // Try to resume existing session if sessionId provided
    if (body.sessionId) {
      const existingId = env.CHAT_SESSION.idFromName(body.sessionId);
      const existingStub = env.CHAT_SESSION.get(existingId);

      // Check if session is resumable
      const stateResponse = await existingStub.fetch(new Request('https://internal/state'));
      if (stateResponse.ok) {
        const state = (await stateResponse.json()) as ChatState | null;

        // Session is resumable if: exists, not ended, less than 24h old
        if (
          state &&
          state.status !== 'ended' &&
          Date.now() - state.createdAt < SESSION_TTL_MS
        ) {
          // Update visitor info (page might have changed)
          if (body.visitor) {
            await existingStub.fetch(
              new Request('https://internal/update-visitor', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ visitorInfo: body.visitor }),
              })
            );
          }

          const wsUrl = new URL(request.url);
          wsUrl.pathname = `/connect/${body.sessionId}`;
          wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';

          return new Response(
            JSON.stringify({
              sessionId: body.sessionId,
              wsUrl: wsUrl.toString(),
              resumed: true,
            }),
            {
              status: 200,
              headers: { ...headers, 'Content-Type': 'application/json' },
            }
          );
        }
      }
      // Session not resumable, fall through to create new one
    }

    // Generate new session ID
    const sessionId = crypto.randomUUID();

    // Get Durable Object stub
    const id = env.CHAT_SESSION.idFromName(sessionId);
    const stub = env.CHAT_SESSION.get(id);

    // Initialize the session with visitor info
    await stub.fetch(
      new Request('https://internal/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionName: sessionId, // Pass UUID for R2 file paths
          visitorInfo: body.visitor,
          ipAddress: clientIp,
          country,
        }),
      })
    );

    // Return session ID and WebSocket URL
    const wsUrl = new URL(request.url);
    wsUrl.pathname = `/connect/${sessionId}`;
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';

    return new Response(
      JSON.stringify({
        sessionId,
        wsUrl: wsUrl.toString(),
        resumed: false,
      }),
      {
        status: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('[start] Error:', error);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }
}

async function handleConnect(request: Request, env: Env, sessionId: string): Promise<Response> {
  if (!sessionId) {
    return new Response('Session ID required', { status: 400 });
  }

  // Get Durable Object stub
  const id = env.CHAT_SESSION.idFromName(sessionId);
  const stub = env.CHAT_SESSION.get(id);

  // Forward WebSocket upgrade to Durable Object
  return stub.fetch(new Request('https://internal/websocket', {
    headers: request.headers,
  }));
}

async function handleSlackWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const body = await request.text();

  // Verify Slack signature
  if (env.SLACK_SIGNING_SECRET) {
    const isValid = await verifySlackSignature(request, body, env.SLACK_SIGNING_SECRET);
    if (!isValid) {
      console.warn('[slack-webhook] Invalid signature');
      return new Response('Invalid signature', { status: 401 });
    }
  }

  const payload = JSON.parse(body) as SlackEventPayload;

  // Handle URL verification (Slack setup)
  if (payload.type === 'url_verification') {
    return new Response(payload.challenge, {
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Handle event callbacks
  if (payload.type === 'event_callback' && payload.event) {
    const event = payload.event;

    // Only process thread replies (not channel messages)
    if (!event.thread_ts) {
      return new Response('OK');
    }

    // Ignore bot messages and message changes/deletions
    if (event.bot_id || event.subtype === 'message_changed' || event.subtype === 'message_deleted') {
      return new Response('OK');
    }

    // Deduplicate events
    if (payload.event_id) {
      try {
        const existing = await env.DB.prepare(
          'SELECT event_id FROM processed_events WHERE event_id = ?'
        )
          .bind(payload.event_id)
          .first();

        if (existing) {
          return new Response('OK'); // Already processed
        }

        // Mark as processed
        await env.DB.prepare('INSERT INTO processed_events (event_id) VALUES (?)')
          .bind(payload.event_id)
          .run();

        // Cleanup old events (fire and forget)
        ctx.waitUntil(
          env.DB.prepare("DELETE FROM processed_events WHERE processed_at < datetime('now', '-1 hour')").run()
        );
      } catch (error) {
        console.error('[slack-webhook] Dedup error:', error);
      }
    }

    // Look up session by thread_ts (include session_name for file uploads)
    try {
      const session = await env.DB.prepare(
        'SELECT id, session_name FROM chat_sessions WHERE slack_thread_ts = ?'
      )
        .bind(event.thread_ts)
        .first<{ id: string; session_name: string | null }>();

      if (session) {
        // Get staff name
        const staffName = await getSlackUserName(event.user, env.SLACK_BOT_TOKEN);

        // Prepare pending files if any (will be processed by DO)
        let pendingFiles: SlackFile[] | undefined;
        if (event.files && event.files.length > 0 && session.session_name) {
          // Filter to supported files and validate URLs
          pendingFiles = event.files.filter((file) => {
            // Check MIME type
            if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
              console.warn(`[slack-webhook] Skipping unsupported file type: ${file.mimetype}`);
              return false;
            }
            // Check size
            if (file.size > MAX_FILE_SIZE) {
              console.warn(`[slack-webhook] Skipping oversized file: ${file.size} bytes`);
              return false;
            }
            // Validate URL (SSRF prevention)
            if (!isValidSlackFileUrl(file.url_private)) {
              console.warn(`[slack-webhook] Skipping file with invalid URL: ${file.url_private}`);
              return false;
            }
            return true;
          });

          if (pendingFiles.length === 0) {
            pendingFiles = undefined;
          }
        } else if (event.files && event.files.length > 0 && !session.session_name) {
          // Legacy session without session_name - can't process files
          console.warn(`[slack-webhook] Legacy session ${session.id} - skipping ${event.files.length} file(s)`);
        }

        // Forward message to Durable Object
        // Note: session.id is the DO's hex ID, so use idFromString (not idFromName)
        const id = env.CHAT_SESSION.idFromString(session.id);
        const stub = env.CHAT_SESSION.get(id);

        // Use waitUntil to avoid Slack 3-second timeout
        // File downloads can take longer, but Slack needs 200 OK immediately
        ctx.waitUntil(
          stub.fetch(
            new Request('https://internal/staff-message', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text: event.text,
                staffName,
                pendingFiles,
                sessionName: session.session_name,
              }),
            })
          )
        );
      }
    } catch (error) {
      console.error('[slack-webhook] Error routing message:', error);
    }
  }

  return new Response('OK');
}

// File upload handlers
async function handleUploadStart(
  request: Request,
  env: Env,
  origin: string | null
): Promise<Response> {
  const headers = corsHeaders(origin, env);

  // Validate origin
  const allowedOrigins = env.ALLOWED_ORIGINS?.split(',') || [];
  const isAllowedOrigin = origin && (allowedOrigins.includes(origin) || origin.includes('localhost'));
  if (!isAllowedOrigin) {
    return new Response(JSON.stringify({ error: 'Invalid origin' }), {
      status: 403,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = (await request.json()) as {
      sessionId: string;
      filename: string;
      mimeType: string;
      size: number;
    };

    const { sessionId, filename, mimeType, size } = body;

    // Validate required fields
    if (!sessionId || !filename || !mimeType || !size) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    // Validate file type
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      return new Response(
        JSON.stringify({ error: 'Dateityp nicht erlaubt. Erlaubt: Bilder, PDF, Text.' }),
        {
          status: 400,
          headers: { ...headers, 'Content-Type': 'application/json' },
        }
      );
    }

    // Validate file size
    if (size > MAX_FILE_SIZE) {
      return new Response(
        JSON.stringify({ error: 'Datei zu groß. Maximum: 10 MB.' }),
        {
          status: 400,
          headers: { ...headers, 'Content-Type': 'application/json' },
        }
      );
    }

    // Verify session exists and is active
    const id = env.CHAT_SESSION.idFromName(sessionId);
    const stub = env.CHAT_SESSION.get(id);
    const stateResponse = await stub.fetch(new Request('https://internal/state'));

    if (!stateResponse.ok) {
      return new Response(JSON.stringify({ error: 'Session not found' }), {
        status: 404,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const state = (await stateResponse.json()) as ChatState | null;
    if (!state || state.status === 'ended') {
      return new Response(JSON.stringify({ error: 'Session not active' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    // Check session age (24h TTL)
    if (Date.now() - state.createdAt > SESSION_TTL_MS) {
      return new Response(JSON.stringify({ error: 'Session expired' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    // Generate file ID and R2 key
    const fileId = crypto.randomUUID();
    const sanitizedName = sanitizeFilename(filename);
    const r2Key = `${sessionId}/${fileId}/${sanitizedName}`;

    // Create presigned URL for direct upload
    // Note: R2 supports presigned URLs via the createMultipartUpload and signedUrl methods
    // For simplicity in v1, we'll use a different approach: store metadata and let client upload via /upload/complete
    // Actually, R2 in Workers doesn't directly support presigned PUT URLs like S3.
    // We'll use a two-phase approach where the worker proxies the upload but streams it.
    // For v1, let's use a simpler approach: accept the file via multipart form in /upload/complete

    const expiresAt = Date.now() + PRESIGNED_URL_EXPIRY * 1000;

    // Store pending upload metadata in D1 for validation
    await env.DB.prepare(
      `INSERT INTO pending_uploads (file_id, session_id, r2_key, filename, mime_type, size, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(fileId, sessionId, r2Key, sanitizedName, mimeType, size, expiresAt)
      .run();

    return new Response(
      JSON.stringify({
        fileId,
        r2Key,
        expiresAt,
        maxSize: MAX_FILE_SIZE,
      }),
      {
        status: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('[upload-start] Error:', error);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }
}

async function handleUploadComplete(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  origin: string | null
): Promise<Response> {
  const headers = corsHeaders(origin, env);

  // Validate origin
  const allowedOrigins = env.ALLOWED_ORIGINS?.split(',') || [];
  const isAllowedOrigin = origin && (allowedOrigins.includes(origin) || origin.includes('localhost'));
  if (!isAllowedOrigin) {
    return new Response(JSON.stringify({ error: 'Invalid origin' }), {
      status: 403,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  try {
    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const fileId = formData.get('fileId') as string | null;
    const sessionId = formData.get('sessionId') as string | null;

    if (!file || !fileId || !sessionId) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    // Validate pending upload exists and hasn't expired
    const pendingUpload = await env.DB.prepare(
      'SELECT * FROM pending_uploads WHERE file_id = ? AND session_id = ? AND expires_at > ?'
    )
      .bind(fileId, sessionId, Date.now())
      .first<{
        file_id: string;
        session_id: string;
        r2_key: string;
        filename: string;
        mime_type: string;
        size: number;
      }>();

    if (!pendingUpload) {
      return new Response(JSON.stringify({ error: 'Upload expired or not found' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    // Validate file size matches declared size (with 5% tolerance for encoding)
    if (file.size > pendingUpload.size * 1.05 || file.size > MAX_FILE_SIZE) {
      return new Response(JSON.stringify({ error: 'File too large' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    // Upload to R2
    await env.FILES_BUCKET.put(pendingUpload.r2_key, file.stream(), {
      httpMetadata: {
        contentType: pendingUpload.mime_type,
        contentDisposition: `attachment; filename="${pendingUpload.filename}"`,
      },
      customMetadata: {
        sessionId: sessionId,
        uploadedAt: new Date().toISOString(),
      },
    });

    // Delete pending upload record
    await env.DB.prepare('DELETE FROM pending_uploads WHERE file_id = ?')
      .bind(fileId)
      .run();

    // Create file attachment object
    const attachment: FileAttachment = {
      id: fileId,
      name: pendingUpload.filename,
      mimeType: pendingUpload.mime_type,
      size: file.size,
      url: `/file/${sessionId}/${fileId}`,
    };

    // Notify Durable Object about the uploaded file
    const id = env.CHAT_SESSION.idFromName(sessionId);
    const stub = env.CHAT_SESSION.get(id);

    await stub.fetch(
      new Request('https://internal/file-uploaded', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attachment,
          r2Key: pendingUpload.r2_key,
        }),
      })
    );

    // Upload to Slack in background (don't block response)
    ctx.waitUntil(uploadFileToSlack(env, sessionId, pendingUpload.r2_key, attachment));

    return new Response(
      JSON.stringify({
        success: true,
        attachment,
      }),
      {
        status: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('[upload-complete] Error:', error);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }
}

async function handleFileDownload(
  request: Request,
  env: Env,
  sessionId: string,
  fileId: string,
  origin: string | null
): Promise<Response> {
  const headers = corsHeaders(origin, env);

  try {
    // Verify session exists and is recent (24h TTL)
    const id = env.CHAT_SESSION.idFromName(sessionId);
    const stub = env.CHAT_SESSION.get(id);
    const stateResponse = await stub.fetch(new Request('https://internal/state'));

    if (!stateResponse.ok) {
      return new Response('Not Found', { status: 404 });
    }

    const state = (await stateResponse.json()) as ChatState | null;
    if (!state) {
      return new Response('Not Found', { status: 404 });
    }

    // Check session age
    if (Date.now() - state.createdAt > SESSION_TTL_MS) {
      return new Response('Session expired', { status: 410 });
    }

    // List objects with prefix to find the file
    const prefix = `${sessionId}/${fileId}/`;
    const listed = await env.FILES_BUCKET.list({ prefix, limit: 1 });

    if (listed.objects.length === 0) {
      return new Response('File not found', { status: 404 });
    }

    const r2Key = listed.objects[0].key;
    const object = await env.FILES_BUCKET.get(r2Key);

    if (!object) {
      return new Response('File not found', { status: 404 });
    }

    // Return the file with security headers
    const responseHeaders = new Headers({
      'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': object.httpMetadata?.contentDisposition || 'attachment',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
      ...headers,
    });

    return new Response(object.body, { headers: responseHeaders });
  } catch (error) {
    console.error('[file-download] Error:', error);
    return new Response('Internal error', { status: 500 });
  }
}

// Upload file to Slack using the new files API
async function uploadFileToSlack(
  env: Env,
  sessionId: string,
  r2Key: string,
  attachment: FileAttachment
): Promise<void> {
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_CHANNEL_ID) {
    console.warn('[uploadFileToSlack] Slack not configured');
    return;
  }

  try {
    // Get session state to get thread_ts
    const id = env.CHAT_SESSION.idFromName(sessionId);
    const stub = env.CHAT_SESSION.get(id);
    const stateResponse = await stub.fetch(new Request('https://internal/state'));

    if (!stateResponse.ok) return;

    const state = (await stateResponse.json()) as ChatState | null;
    if (!state?.slackThreadTs) return;

    // Get file from R2
    const object = await env.FILES_BUCKET.get(r2Key);
    if (!object) return;

    // Step 1: Get upload URL from Slack (new API since May 2024)
    const getUrlResponse = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        filename: attachment.name,
        length: attachment.size.toString(),
      }),
    });

    const getUrlResult = (await getUrlResponse.json()) as {
      ok: boolean;
      upload_url?: string;
      file_id?: string;
      error?: string;
    };

    if (!getUrlResult.ok || !getUrlResult.upload_url || !getUrlResult.file_id) {
      console.error('[uploadFileToSlack] Failed to get upload URL:', getUrlResult.error);
      return;
    }

    // Step 2: Upload file to Slack's URL
    const fileBuffer = await object.arrayBuffer();
    const uploadResponse = await fetch(getUrlResult.upload_url, {
      method: 'POST',
      body: fileBuffer,
    });

    if (!uploadResponse.ok) {
      console.error('[uploadFileToSlack] Failed to upload file:', uploadResponse.status);
      return;
    }

    // Step 3: Complete the upload and post to channel/thread
    const completeResponse = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: [{ id: getUrlResult.file_id, title: attachment.name }],
        channel_id: env.SLACK_CHANNEL_ID,
        thread_ts: state.slackThreadTs,
        initial_comment: `📎 Kunde hat eine Datei hochgeladen: ${attachment.name}`,
      }),
    });

    const completeResult = (await completeResponse.json()) as { ok: boolean; error?: string };
    if (!completeResult.ok) {
      console.error('[uploadFileToSlack] Failed to complete upload:', completeResult.error);
    }
  } catch (error) {
    console.error('[uploadFileToSlack] Error:', error);
  }
}
