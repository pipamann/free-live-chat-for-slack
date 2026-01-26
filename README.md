# Free Live Chat for Slack

A **completely free** live chat system that connects your website visitors to your Slack workspace. Built entirely on Cloudflare's free tier - no monthly fees, no per-seat pricing, no limits.

```
Website Visitor              Cloudflare Edge              Your Slack
      │                            │                           │
      │──── WebSocket ────────────►│ Durable Object            │
      │                            │ (sub-50ms latency)        │
      │                            │      │                    │
      │                            │      │─── Slack API ─────►│
      │                            │      │    (new thread)    │
      │                            │      │                    │
      │◄─── WebSocket ─────────────│◄─────│◄── Events API ─────│
      │     (staff reply)          │      │    (webhook)       │
```

## Why This Exists

Most live chat tools charge $15-50/seat/month. If you already use Slack, why pay again?

This project gives you:
- **$0/month** - Runs on Cloudflare's free tier
- **Real-time** - WebSocket-based, not polling
- **Global edge** - Sub-50ms latency worldwide via Durable Objects
- **AI assistant** (optional) - RAG-powered bot using free Workers AI
- **File sharing** - Customers can send files, stored in R2
- **Session resumption** - Customers can close the tab and come back
- **Spam protection** - Cloudflare Turnstile integration

## Tech Stack (All Free Tier)

| Service | Purpose | Free Limit |
|---------|---------|------------|
| **Workers** | API & routing | 100k requests/day |
| **Durable Objects** | WebSocket sessions | 1M requests/month |
| **D1** | Session metadata | 5GB storage |
| **R2** | File uploads | 10GB storage |
| **Workers AI** | AI chatbot | 10k neurons/day |
| **Vectorize** | Knowledge base | 5M vectors |
| **Turnstile** | Spam protection | Unlimited |

## Features

### Core Chat
- WebSocket-based real-time messaging
- Bidirectional sync with Slack threads
- Staff member identification (shows who replied)
- 24-hour session resumption
- Visitor metadata (browser, OS, location)

### AI Chatbot (Optional)
- RAG-powered responses from your knowledge base
- Automatic handoff to humans for sensitive topics
- Smart email collection when staff is unavailable
- Confidence-based escalation
- Disabled automatically when staff replies

### File Handling
- 10MB file uploads from customers
- Secure presigned URLs
- Files forwarded to Slack thread
- Automatic cleanup

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/YOUR_USERNAME/free-live-chat-for-slack.git
cd free-live-chat-for-slack
npm install
```

### 2. Create Cloudflare Resources

```bash
# Login to Cloudflare
wrangler login

# Create D1 database
wrangler d1 create live-chat-db
# Copy the database_id to wrangler.jsonc

# Create R2 bucket
wrangler r2 bucket create live-chat-files

# (Optional) Create Vectorize index for AI
npm run vectorize:create
```

### 3. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App
2. Add Bot Token Scopes:
   - `chat:write` - Post messages
   - `channels:history` - Read thread replies
   - `users:read` - Get staff names
   - `files:read` - Access shared files
3. Install to workspace
4. Copy the Bot Token (`xoxb-...`)
5. Enable Events API → Set URL to `https://YOUR_WORKER.workers.dev/slack-webhook`
6. Subscribe to `message.channels` event
7. Copy the Signing Secret

### 4. Configure

Update `wrangler.jsonc`:
```jsonc
{
  "vars": {
    "SLACK_CHANNEL_ID": "C0123456789",  // Your support channel
    "ALLOWED_ORIGINS": "https://your-website.com"
  }
}
```

Set secrets:
```bash
wrangler secret put SLACK_BOT_TOKEN        # xoxb-... from Slack
wrangler secret put SLACK_SIGNING_SECRET   # From Slack App settings
wrangler secret put TURNSTILE_SECRET_KEY   # From Cloudflare Turnstile
```

### 5. Deploy

```bash
# Run migrations
npm run db:migrate

# Deploy worker
npm run deploy
```

### 6. Add Widget to Your Website

```html
<script>
  window.CHAT_CONFIG = {
    serviceUrl: 'https://YOUR_WORKER.workers.dev',
    turnstileSiteKey: 'YOUR_TURNSTILE_SITE_KEY'
  };
</script>
<script src="https://YOUR_WORKER.workers.dev/widget.js"></script>
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/start` | POST | Create new chat session |
| `/connect/:sessionId` | WebSocket | Real-time messaging |
| `/slack-webhook` | POST | Slack Events API handler |
| `/upload/:sessionId` | POST | Get presigned upload URL |
| `/health` | GET | Health check |

## Configuration

### Environment Variables

**Secrets** (via `wrangler secret put`):
| Name | Required | Description |
|------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Slack bot token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Yes | Slack webhook verification |
| `TURNSTILE_SECRET_KEY` | Yes | Spam protection |
| `N8N_WEBHOOK_URL` | No | Ticket creation webhook |

**Public** (in `wrangler.jsonc`):
| Name | Description |
|------|-------------|
| `SLACK_CHANNEL_ID` | Slack channel for chat messages |
| `ALLOWED_ORIGINS` | CORS allowed origins (comma-separated) |

### AI Chatbot Configuration

Edit `src/prompts.ts` to customize:
- Bot personality and tone
- Handoff keywords (triggers human escalation)
- Response templates
- Your product/service name

## Architecture

```
src/
├── index.ts          # Worker entry, routing
├── ChatSession.ts    # Durable Object (WebSocket handling)
├── bot.ts            # AI chatbot with RAG
├── prompts.ts        # Configurable bot personality
├── slack.ts          # Slack API integration
├── files.ts          # R2 file handling
└── types.ts          # TypeScript types

scripts/
├── prepare-embeddings.ts  # Build knowledge base
└── test-models.ts         # Compare AI models
```

## Development

```bash
# Local development
npm run dev

# For Slack webhooks locally, use ngrok
ngrok http 8787
# Update Slack Events API URL to ngrok URL
```

## Customization

### Adding Knowledge Base Content

1. Create JSON files with Q&A pairs in `data/knowledge/`
2. Run `npm run embeddings:prepare` to upload to Vectorize
3. The AI will use this context for responses

### Styling the Widget

The chat widget is customizable via CSS variables. See `widget/` directory for the frontend code.

### Multi-language Support

Edit `src/prompts.ts` to change the bot language. The system supports any language - just update the prompts and handoff keywords.

## License

MIT - Use it however you want.

## Contributing

PRs welcome! This project is intentionally simple - please keep it that way.

---

**Built with Cloudflare Workers, Durable Objects, D1, R2, Workers AI, and Vectorize.**
