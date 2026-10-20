-- Migration: v1.1 data cleanup
-- Run with: npm run db:migrate

-- Upload reservations now live in each chat's Durable Object
DROP TABLE IF EXISTS pending_uploads;

-- Visitor IP addresses are no longer stored; remove the ones collected by v1.0
UPDATE chat_sessions SET ip_address = NULL;

-- Chats are now kept for 30 days; apply that to rows from v1.0, which kept them forever
DELETE FROM chat_sessions WHERE created_at < datetime('now', '-30 days');
