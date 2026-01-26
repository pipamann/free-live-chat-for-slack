-- Migration: Create pending_uploads table for file upload flow
-- Run with: npm run db:migrate

CREATE TABLE IF NOT EXISTS pending_uploads (
  file_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Index for looking up pending uploads by session
CREATE INDEX IF NOT EXISTS idx_pending_uploads_session ON pending_uploads(session_id);

-- Index for cleaning up expired uploads
CREATE INDEX IF NOT EXISTS idx_pending_uploads_expires ON pending_uploads(expires_at);
