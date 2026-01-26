export interface Env {
  // Durable Object
  CHAT_SESSION: DurableObjectNamespace;

  // D1 Database
  DB: D1Database;

  // R2 Bucket for file uploads
  FILES_BUCKET: R2Bucket;

  // Workers AI
  AI: Ai;

  // Vectorize index for support knowledge base
  SUPPORT_INDEX: VectorizeIndex;

  // Slack configuration
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_CHANNEL_ID: string;

  // n8n webhook for ticket creation (creates Freshdesk tickets via n8n workflow)
  N8N_WEBHOOK_URL?: string;

  // Turnstile
  TURNSTILE_SECRET_KEY: string;

  // CORS
  ALLOWED_ORIGINS: string;
}

export interface FileAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url?: string;
}

export interface ChatMessage {
  id: string;
  role: 'customer' | 'staff' | 'bot';
  content: string;
  timestamp: number;
  staffName?: string;
  attachments?: FileAttachment[];
  botConfidence?: number;
  isHandoff?: boolean; // True if bot is deferring to human staff
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

export interface ChatState {
  sessionId: string;
  sessionName?: string; // Original UUID used for R2 file paths
  status: 'active' | 'answered' | 'escalated' | 'ended';
  messages: ChatMessage[];
  slackThreadTs?: string;
  customerEmail?: string;
  createdAt: number;
  visitorInfo?: VisitorInfo;
  ipAddress?: string;
  country?: string;
  // Bot state
  botActive: boolean;
  botMessageCount: number;
  lastBotResponse?: number;
}

export interface WebSocketMessage {
  type: 'message' | 'message_ack' | 'status' | 'error' | 'ping' | 'pong' | 'file_ready' | 'typing';
  payload?: unknown;
}

export interface CustomerMessage {
  type: 'message';
  content: string;
}

export interface EmailSubmission {
  type: 'email';
  email: string;
}

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private: string;
}

export interface SlackMessageEvent {
  type: 'message';
  subtype?: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  files?: SlackFile[];
}

export interface SlackEventPayload {
  type: 'url_verification' | 'event_callback';
  challenge?: string;
  token?: string;
  team_id?: string;
  api_app_id?: string;
  event?: SlackMessageEvent;
  event_id?: string;
  event_time?: number;
}
