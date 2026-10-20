import { vi } from 'vitest';

export const ORIGIN = 'https://example.com';

/** Headers Slack would send for `body`. */
export async function signSlackBody(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`v0:${timestamp}:${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Headers({
    'Content-Type': 'application/json',
    'X-Slack-Request-Timestamp': String(timestamp),
    'X-Slack-Signature': `v0=${hex}`,
  });
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
  /** The `ts` the fake chat.postMessage returned. */
  ts?: string;
}

// Unique across tests, like real Slack timestamps (D1 is shared by all tests in a file)
let lastTs = 0;

/**
 * Replaces outbound fetch with fakes for Turnstile, Slack and the ticket webhook.
 * Turnstile accepts the token "valid-token". Returns the recorded calls.
 */
export function mockOutboundFetch(options: { slackDown?: boolean } = {}) {
  const calls: RecordedCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init as RequestInit);
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : new TextDecoder().decode(await request.arrayBuffer());
    let body: Record<string, unknown> = {};
    if ((request.headers.get('Content-Type') ?? '').includes('json')) body = JSON.parse(text);
    else if (url.hostname !== 'files.slack.com' && text) body = Object.fromEntries(new URLSearchParams(text));
    const call: RecordedCall = { url: request.url, method: request.method, headers: request.headers, body };
    calls.push(call);

    if (url.hostname === 'challenges.cloudflare.com') {
      return Response.json({ success: body.response === 'valid-token' });
    }
    if (url.hostname === 'slack.com') {
      if (options.slackDown) return new Response('down', { status: 503 });
      switch (url.pathname) {
        case '/api/chat.postMessage':
          call.ts = `1700000000.${String(++lastTs).padStart(6, '0')}`;
          return Response.json({ ok: true, ts: call.ts });
        case '/api/users.info':
          return Response.json({ ok: true, user: { real_name: 'Alex Example', profile: { display_name: 'Alex' } } });
        case '/api/files.getUploadURLExternal':
          return Response.json({ ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F123' });
        default:
          return Response.json({ ok: true });
      }
    }
    if (url.hostname === 'files.slack.com') {
      if (url.pathname.startsWith('/upload/')) return new Response('OK');
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), {
        headers: { 'Content-Type': 'application/pdf' },
      });
    }
    if (url.hostname === 'tickets.example.com') {
      return new Response('OK');
    }
    throw new Error(`Unexpected outbound fetch: ${request.url}`);
  });
  return calls;
}

export function slackCalls(calls: RecordedCall[], method: string) {
  return calls.filter((call) => call.url === `https://slack.com/api/${method}`);
}

/** Resolves once `predicate` is true, polling briefly (for work the Worker finishes after responding). */
export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
