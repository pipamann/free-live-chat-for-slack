/**
 * Request helpers for the public endpoints: origin checks, CORS, input limits, Turnstile.
 */

import type { Env, VisitorInfo } from './types';

/** `ALLOWED_ORIGINS` as a list. Entries are exact origins such as `https://example.com`. */
export function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * Exact match only. The `Origin` header stops other websites from embedding your chat;
 * it is not authentication (non-browser clients can send any value).
 */
export function isAllowedOrigin(origin: string | null, env: Env): origin is string {
  return origin !== null && allowedOrigins(env).includes(origin);
}

export function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (isAllowedOrigin(origin, env)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Session and file IDs are random UUIDs; anything else is rejected before it reaches storage. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Reads a request body as text, giving up once it exceeds `maxBytes`. Returns null if too large. */
export async function readBodyText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > maxBytes) return null;
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Parses a JSON object body of at most `maxBytes`. Returns null for oversized or invalid input. */
export async function readJsonObject(request: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  const text = await readBodyText(request, maxBytes);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Keeps only the known visitor fields, as strings and numbers of bounded size. */
export function sanitizeVisitorInfo(input: unknown): VisitorInfo | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
  const size = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), 100_000) : 0;
  return {
    userAgent: text(raw.userAgent, 512),
    language: text(raw.language, 35),
    pageUrl: text(raw.pageUrl, 2048),
    pageTitle: text(raw.pageTitle, 300),
    referrer: text(raw.referrer, 2048),
    screenWidth: size(raw.screenWidth),
    screenHeight: size(raw.screenHeight),
    timezone: text(raw.timezone, 64),
  };
}

/** Server-side Turnstile check. https://developers.cloudflare.com/turnstile/get-started/server-side-validation/ */
export async function verifyTurnstile(token: unknown, ip: string | null, secret: string): Promise<boolean> {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return false;
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set('remoteip', ip);
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const result = (await response.json()) as { success?: boolean };
    return result.success === true;
  } catch (error) {
    console.error('[turnstile] siteverify failed:', error);
    return false;
  }
}
