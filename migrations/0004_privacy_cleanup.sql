-- Migration: v1.1 data cleanup
-- Run with: npm run db:migrate

-- Upload reservations now live in each chat's Durable Object
DROP TABLE IF EXISTS pending_uploads;

-- Visitor IP addresses are no longer stored; remove the ones collected by v1.0
UPDATE chat_sessions SET ip_address = NULL;
