-- Migration: Create chat_sessions table for live chat
-- Run with: npm run db:migrate

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  slack_thread_ts TEXT,
  status TEXT DEFAULT 'active',  -- active, answered, escalated, ended
  customer_email TEXT,
  ip_address TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Index for looking up sessions by Slack thread timestamp
CREATE INDEX IF NOT EXISTS idx_chat_thread_ts ON chat_sessions(slack_thread_ts);
CREATE INDEX IF NOT EXISTS idx_chat_status ON chat_sessions(status);

-- Table to track processed Slack event IDs (for deduplication)
CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  processed_at TEXT DEFAULT (datetime('now'))
);

-- Auto-cleanup old processed events (older than 1 hour)
-- This is handled in application code
