# Setup Checklist

## Required Setup

- [ ] Create D1 database: `wrangler d1 create live-chat-db`
- [ ] Update `database_id` in `wrangler.jsonc`
- [ ] Create R2 bucket: `wrangler r2 bucket create live-chat-files`
- [ ] Create Slack app with required scopes
- [ ] Set `SLACK_BOT_TOKEN` secret
- [ ] Set `SLACK_SIGNING_SECRET` secret
- [ ] Set `SLACK_CHANNEL_ID` in `wrangler.jsonc`
- [ ] Set `ALLOWED_ORIGINS` in `wrangler.jsonc`
- [ ] Create Turnstile widget and set `TURNSTILE_SECRET_KEY`
- [ ] Run migrations: `npm run db:migrate`
- [ ] Deploy: `npm run deploy`
- [ ] Configure Slack Events API webhook URL

## Optional Setup

### AI Chatbot

- [ ] Create Vectorize index: `npm run vectorize:create`
- [ ] Customize prompts in `src/prompts.ts`
- [ ] Prepare knowledge base embeddings: `npm run embeddings:prepare`

### Ticket Integration (n8n, Freshdesk, etc.)

- [ ] Set `N8N_WEBHOOK_URL` secret (optional)

## Post-Deploy

- [ ] Add chat widget to your website
- [ ] Test end-to-end: website → Slack → reply → website
- [ ] Verify Turnstile is blocking bots
