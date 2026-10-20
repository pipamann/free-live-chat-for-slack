/**
 * Slack Web API calls, request signature verification and text conversion.
 */

import type { Env, SlackFile } from './types';

const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

/**
 * Verifies Slack's `v0` request signature (HMAC-SHA256 over `v0:{timestamp}:{body}`).
 * Rejects requests older than five minutes so captured requests cannot be replayed.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export async function verifySlackSignature(
  headers: Headers,
  body: string,
  signingSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const timestamp = headers.get('X-Slack-Request-Timestamp');
  const signature = headers.get('X-Slack-Signature');
  if (!signingSecret || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_MAX_AGE_SECONDS) return false;

  const match = /^v0=([0-9a-f]{64})$/.exec(signature);
  if (!match) return false;
  const signatureBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    signatureBytes[i] = parseInt(match[1].slice(i * 2, i * 2 + 2), 16);
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  // subtle.verify compares in constant time
  return crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(`v0:${timestamp}:${body}`));
}

/**
 * Escapes text written by visitors before it goes into a Slack message, so it cannot
 * ping the channel (`<!channel>`), mention people or disguise links (`<https://evil|bank.com>`).
 */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Quotes every line, so multi-line visitor messages stay inside the quote block. */
export function quoteForSlack(text: string): string {
  return escapeSlackText(text)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * Turns a Slack message into plain text for the visitor: resolves link markup,
 * mentions and HTML entities. The widget renders the result as text, never as HTML.
 */
export function slackToPlainText(text: string): string {
  return text
    .replace(/<([^<>]+)>/g, (_, inner: string) => {
      const [target, label] = splitOnce(inner, '|');
      if (target.startsWith('@')) return label ? `@${label}` : '@someone';
      if (target.startsWith('#')) return label ? `#${label}` : '#channel';
      if (target.startsWith('!')) {
        if (label) return label;
        const command = target.slice(1).split('^')[0];
        return ['here', 'channel', 'everyone'].includes(command) ? `@${command}` : '';
      }
      const url = target.startsWith('mailto:') ? target.slice('mailto:'.length) : target;
      if (!label || label === url || label === target) return url;
      return `${label} (${url})`;
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);
  return index === -1 ? [value, undefined] : [value.slice(0, index), value.slice(index + 1)];
}

/** Only files hosted by Slack may be downloaded with the bot token (prevents SSRF and token leaks). */
export function isSlackFileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      ['files.slack.com', 'files-origin.slack.com'].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

async function callSlack<T extends { ok: boolean; error?: string }>(
  env: Env,
  method: string,
  body: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as T;
  if (!result.ok) {
    throw new Error(`Slack ${method} failed: ${result.error ?? response.status}`);
  }
  return result;
}

export function isSlackConfigured(env: Env): boolean {
  return Boolean(env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL_ID);
}

/** Posts a message to the support channel (or into a thread) and returns its timestamp. */
export async function postSlackMessage(
  env: Env,
  text: string,
  options: { threadTs?: string } = {}
): Promise<string> {
  const result = await callSlack<{ ok: boolean; error?: string; ts: string }>(env, 'chat.postMessage', {
    channel: env.SLACK_CHANNEL_ID,
    text,
    thread_ts: options.threadTs,
    unfurl_links: false,
    unfurl_media: false,
  });
  return result.ts;
}

export async function getSlackUserName(env: Env, userId: string): Promise<string | undefined> {
  try {
    const response = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const result = (await response.json()) as {
      ok: boolean;
      user?: { real_name?: string; profile?: { display_name?: string; real_name?: string } };
    };
    if (result.ok && result.user) {
      return result.user.profile?.display_name || result.user.real_name || result.user.profile?.real_name;
    }
  } catch (error) {
    console.error('[slack] users.info failed:', error);
  }
  return undefined;
}

/** Uploads a file into a thread with the `files.getUploadURLExternal` + `files.completeUploadExternal` flow. */
export async function uploadFileToSlackThread(
  env: Env,
  threadTs: string,
  file: { name: string; bytes: ArrayBuffer },
  comment: string
): Promise<void> {
  const form = new URLSearchParams({ filename: file.name, length: String(file.bytes.byteLength) });
  const urlResponse = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  const upload = (await urlResponse.json()) as { ok: boolean; upload_url?: string; file_id?: string; error?: string };
  if (!upload.ok || !upload.upload_url || !upload.file_id) {
    throw new Error(`Slack files.getUploadURLExternal failed: ${upload.error ?? urlResponse.status}`);
  }

  const putResponse = await fetch(upload.upload_url, { method: 'POST', body: file.bytes });
  if (!putResponse.ok) {
    throw new Error(`Slack file upload failed: HTTP ${putResponse.status}`);
  }

  await callSlack(env, 'files.completeUploadExternal', {
    files: [{ id: upload.file_id, title: file.name }],
    channel_id: env.SLACK_CHANNEL_ID,
    thread_ts: threadTs,
    initial_comment: comment,
  });
}

/**
 * Downloads a file a staff member posted in Slack. The bot token is only sent to Slack's
 * own file host; a redirect to storage is followed without it.
 */
export async function downloadSlackFile(env: Env, file: SlackFile): Promise<Response> {
  if (!isSlackFileUrl(file.url_private)) {
    throw new Error(`Refusing to download from ${file.url_private}`);
  }
  let response = await fetch(file.url_private, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('Location');
    if (!location) throw new Error('Slack file redirect without location');
    response = await fetch(new URL(location, file.url_private));
  }
  if (!response.ok) {
    throw new Error(`Slack file download failed: HTTP ${response.status}`);
  }
  return response;
}
