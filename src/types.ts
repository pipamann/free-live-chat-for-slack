import type { ChatSession } from './ChatSession';

export interface Env {
  // Bindings (wrangler.jsonc)
  CHAT_SESSION: DurableObjectNamespace<ChatSession>;
  DB: D1Database;
  FILES_BUCKET: R2Bucket;
  /** Limits how many new chats one IP address can start per minute. */
  START_LIMITER?: RateLimit;
  /** Optional AI bot. It only runs when both bindings exist (see docs/AI_CHATBOT.md). */
  AI?: Ai;
  SUPPORT_INDEX?: VectorizeIndex;

  // Variables (wrangler.jsonc)
  SLACK_CHANNEL_ID: string;
  /** Comma-separated list of exact origins allowed to embed the chat, e.g. `https://example.com`. */
  ALLOWED_ORIGINS: string;
  /** Set to "true" (only in .dev.vars) to serve a test page at /demo. */
  ENABLE_DEMO_PAGE?: string;
  /** Turnstile site key for the /demo page. Your own site passes it to the widget instead. */
  TURNSTILE_SITE_KEY?: string;

  // Secrets (wrangler secret put)
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  /** Strongly recommended: without it anyone can open chats from a script. */
  TURNSTILE_SECRET_KEY?: string;
  /** Optional: receives a JSON payload when a visitor leaves contact details (n8n, Zapier, your helpdesk…). */
  TICKET_WEBHOOK_URL?: string;
  /** Optional: sent as `Authorization: Bearer <secret>` to the ticket webhook. */
  TICKET_WEBHOOK_SECRET?: string;
  /** @deprecated Old name of TICKET_WEBHOOK_URL, still read as a fallback. */
  N8N_WEBHOOK_URL?: string;
}

type ChatEnv = Env;
declare global {
  namespace Cloudflare {
    // Types `env` in `cloudflare:workers` and `cloudflare:test`
    interface Env extends ChatEnv {}
  }
}

export interface FileAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Download path relative to the Worker, `/file/{sessionId}/{fileId}`. */
  url: string;
}

export interface ChatMessage {
  id: string;
  role: 'customer' | 'staff' | 'bot';
  content: string;
  timestamp: number;
  staffName?: string;
  attachments?: FileAttachment[];
  /** The bot handed the conversation over to a human. */
  isHandoff?: boolean;
}

export interface VisitorInfo {
  userAgent: string;
  language: string;
  pageUrl: string;
  pageTitle: string;
  referrer: string;
  screenWidth: number;
  screenHeight: number;
  timezone: string;
}

export type ChatStatus = 'active' | 'answered' | 'escalated' | 'ended';

export interface PendingUpload {
  name: string;
  mimeType: string;
  size: number;
  expiresAt: number;
}

export interface ChatState {
  /** Durable Object ID (hex). Primary key of the D1 routing table. */
  sessionId: string;
  /** Public session UUID used in URLs and R2 keys. */
  sessionName: string;
  status: ChatStatus;
  messages: ChatMessage[];
  createdAt: number;
  visitorInfo?: VisitorInfo;
  country?: string;
  slackThreadTs?: string;
  /** How many visitor messages have been posted to Slack (the rest is retried on the next message). */
  slackSyncedCount: number;
  customerEmail?: string;
  customerPhone?: string;
  botActive: boolean;
  firstCustomerMessageAt?: number;
  stage1Sent?: boolean;
  stage2Sent?: boolean;
  uploadCount: number;
  pendingUploads: Record<string, PendingUpload>;
  /** fileId → R2 key, for downloads and deletion. */
  files: Record<string, string>;
}

/** Messages the server sends over the WebSocket. */
export type ServerMessage =
  | { type: 'status'; payload: { status: ChatStatus; messages?: ChatMessage[]; message?: string } }
  | { type: 'message'; payload: ChatMessage }
  | { type: 'message_ack'; payload: { id: string; clientId?: string } }
  | { type: 'typing'; payload: { sender: 'bot'; name: string } }
  | { type: 'error'; payload: { message: string } };

/** Messages the widget sends over the WebSocket. `email` submits the contact form. */
export type ClientMessage =
  | { type: 'message'; content: string; clientId?: string }
  | { type: 'email'; email?: string; phone?: string }
  | { type: 'pong' };

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private: string;
}

export interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  files?: SlackFile[];
}

export interface SlackEventPayload {
  type: 'url_verification' | 'event_callback' | string;
  challenge?: string;
  team_id?: string;
  api_app_id?: string;
  event?: SlackMessageEvent;
  event_id?: string;
  event_time?: number;
}
