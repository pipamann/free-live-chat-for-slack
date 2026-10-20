/**
 * Tunables. Everything here can be changed without a migration.
 * Visitor- and Slack-facing wording lives in texts.ts, the AI bot's prompt in prompts.ts.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Sessions
/** Visitors can reload the page or come back and continue the same chat within this window. */
export const SESSION_RESUME_TTL_MS = 24 * HOUR;
/**
 * Transcript, uploaded files and the D1 routing row are deleted this long after a chat starts
 * (chats without a single visitor message: after SESSION_RESUME_TTL_MS). Slack keeps its copy.
 */
export const SESSION_RETENTION_MS = 30 * DAY;
export const MAX_MESSAGE_LENGTH = 1000;
export const MAX_MESSAGES_PER_MINUTE = 10;
/** Hard cap so a single chat cannot grow without bound (Durable Object values are limited to 2 MB). */
export const MAX_MESSAGES_PER_SESSION = 300;

// Automatic replies while the visitor waits for a human (used when the AI bot is off)
/** "Checking whether someone is available…" */
export const STAGE_1_DELAY_MS = 8 * SECOND;
/** "Nobody is available, leave your contact details" + contact form. Counted from the first visitor message. */
export const STAGE_2_DELAY_MS = 30 * SECOND;

// Files
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
export const MAX_UPLOADS_PER_SESSION = 10;
export const UPLOAD_RESERVATION_TTL_MS = 5 * MINUTE;
/** Allowed MIME types and the file extension each one must carry. */
export const ALLOWED_FILE_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

// AI bot (only active when the AI and SUPPORT_INDEX bindings exist, see docs/AI_CHATBOT.md)
/** Multilingual embedding model (100+ languages), 1024 dimensions. The Vectorize index must match. */
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const EMBEDDING_DIMENSIONS = 1024;
/**
 * Multilingual chat model that stays on the Workers AI free plan. An answer costs roughly 25 to 40
 * neurons, so the free 10,000 neurons a day cover a few hundred answers.
 */
export const TEXT_MODEL = '@cf/google/gemma-4-26b-a4b-it';
/**
 * Model-specific request options; change them together with TEXT_MODEL. Gemma 4 "thinks" by default,
 * which spends the token budget before the answer and adds nothing to short support replies.
 */
export const TEXT_MODEL_OPTIONS = { chat_template_kwargs: { enable_thinking: false } };
/** Below this similarity score the bot hands over instead of answering. Tune with `npm run models:test`. */
export const CONFIDENCE_THRESHOLD = 0.5;
/** Wait this long for follow-up messages before the bot answers. */
export const BOT_DEBOUNCE_MS = 2 * SECOND;
export const BOT_MAX_HISTORY_MESSAGES = 10;
export const BOT_MAX_CONTEXT_CHARS = 4000;
export const BOT_MAX_REPLY_CHARS = 1200;
