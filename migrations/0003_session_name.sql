-- Migration: Add session_name column for storing original UUID
-- This allows routing Slack file uploads back to the correct R2 path
-- Run with: npm run db:migrate

ALTER TABLE chat_sessions ADD COLUMN session_name TEXT;

-- Index for looking up sessions by session_name (the original UUID)
CREATE INDEX IF NOT EXISTS idx_chat_session_name ON chat_sessions(session_name);
