# Free Live Chat for Slack

A live chat for your website that you answer from Slack. Every conversation becomes a thread in a Slack channel; your team replies in the thread and the visitor sees the answer instantly. It runs on Cloudflare's free plan: no monthly fee, no per-seat pricing.

```
Website visitor                 Cloudflare                          Your Slack
      │                              │                                   │
      │── widget.js, WebSocket ─────►│ Worker ──► Durable Object         │
      │                              │            (one per chat)         │
      │                              │                 │── new thread ──►│
      │                              │                 │                 │
      │◄──────── staff reply ────────│◄── Events API ──│◄── thread reply │
```

## Features

- **Real-time chat** over WebSockets. Idle chats hibernate, so they cost nothing while nobody types.
- **One Slack thread per chat** with the visitor's country, browser and page. Replies starting with `//` stay in Slack as notes for colleagues.
- **Automatic replies while you're busy:** after 8 seconds "checking whether someone is available", after 30 seconds a contact form (email or phone). The details go to the thread and, optionally, to a webhook (n8n, Zapier, your helpdesk).
- **Files both ways:** images, PDFs and text files up to 10 MB.
- **One script tag** for the widget: no build step, no dependencies, works on any site, light and dark mode, full screen on phones.
- **Spam protection:** Cloudflare Turnstile and a per-IP limit for new chats.
- **Privacy by default:** no IP addresses stored, page URLs without query strings, everything deleted after 30 days (Slack keeps its own copy).
- **Optional AI assistant** that answers from your FAQ until a human takes over. Off by default, see [docs/AI_CHATBOT.md](docs/AI_CHATBOT.md).

## What "free" means

Everything stays within Cloudflare's free allowances (as of October 2026):

| Service | Used for | Free allowance |
|---|---|---|
| Workers | API, widget, Slack webhook | 100,000 requests/day, 10 ms CPU per request; static files like `widget.js` are free and unlimited |
| Durable Objects | One object per chat: WebSockets, transcript | 100,000 requests/day (incoming WebSocket messages are billed at 20:1), 13,000 GB-s/day, 5 GB |
| D1 | Maps Slack threads to chats | 5 million rows read and 100,000 written per day |
| R2 | Files sent in the chat | 10 GB, 1 million writes and 10 million reads per month |
| Turnstile | Spam protection | Unlimited |
| Workers AI *(optional)* | AI assistant | 10,000 neurons/day, enough for a few hundred answers |
| Vectorize *(optional)* | AI assistant's knowledge base | 5 million stored dimensions (about 4,800 FAQ entries), 30 million queried dimensions/month |

In practice: a typical chat (a few page views, ten messages each way) uses about 30 Worker requests (Slack calls the webhook for every message in the thread, including the bot's own) and about 20 Durable Object requests, so the daily allowance covers roughly 3,000 chats. Cloudflare asks for a payment method before it enables R2, even if you stay within the free allowance.

**Speed:** the Worker runs in the Cloudflare location nearest to the visitor. Each chat lives in a Durable Object that is created near the visitor who starts it and stays there. Durable Objects run in fewer locations than Workers (none in South America, Africa or the Middle East yet), so messages typically take tens of milliseconds, more on other continents. Staff replies arrive as fast as Slack delivers them, usually within a second.

## Setup

You need a Cloudflare account, a Slack workspace where you can install apps, a channel just for the chats (every message in it reaches the Worker), and Node.js 22 or newer.

### 1. Install

```bash
git clone https://github.com/pipamann/free-live-chat-for-slack.git
cd free-live-chat-for-slack
npm install
npx wrangler login
```

### 2. Create the Cloudflare resources

```bash
npx wrangler d1 create live-chat-db         # copy the database_id into wrangler.jsonc
npx wrangler r2 bucket create live-chat-files
npm run db:migrate
```

Create a Turnstile widget in the Cloudflare dashboard (Turnstile → Add widget) for your website's domain. Note the site key and the secret key.

### 3. Configure and deploy

In `wrangler.jsonc`, set `ALLOWED_ORIGINS` to the exact origins of your website, for example `"https://example.com,https://www.example.com"`. Then:

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY
npm run deploy                              # note the URL, e.g. https://free-live-chat-for-slack.you.workers.dev
```

### 4. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**, pick your workspace and paste [`slack-app-manifest.json`](slack-app-manifest.json). It requests these bot scopes: `chat:write`, `channels:history`, `groups:history` (private channels), `users:read` (staff names), `files:read` and `files:write`.
2. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`) and, under **Basic Information**, the **Signing Secret**:
   ```bash
   npx wrangler secret put SLACK_BOT_TOKEN
   npx wrangler secret put SLACK_SIGNING_SECRET
   ```
3. Put the support channel's ID (channel details → bottom of the "About" tab, `C0…`) into `SLACK_CHANNEL_ID` in `wrangler.jsonc` and run `npm run deploy` again.
4. **Event Subscriptions** → on → Request URL `https://YOUR_WORKER.workers.dev/slack-webhook` (Slack checks it immediately) → **Subscribe to bot events**: `message.channels`, plus `message.groups` for a private channel → Save. Reinstall the app if Slack asks.
5. Invite the bot to the channel: `/invite @Live Chat`.

### 5. Add the widget to your website

```html
<script src="https://YOUR_WORKER.workers.dev/widget.js" data-turnstile-site-key="0x…" defer></script>
```

Open your website, send a message and answer it in the Slack thread. If something does not arrive, `npm run tail` shows the Worker's logs.

## Answering chats

- Reply in the thread; the visitor sees your display name. Files you attach are forwarded (images, PDF, text).
- Replies starting with `//` are not sent to the visitor.
- As soon as someone replies, the automatic messages and the AI assistant stop.
- If nobody answers within 30 seconds, the visitor gets a contact form. What they enter is posted to the thread and, if `TICKET_WEBHOOK_URL` is set, sent there as JSON: `email`, `phone`, `transcript`, `messages`, `visitor_info`, `country`, `session_id`, `slack_thread_ts`, `submitted_at`. With `TICKET_WEBHOOK_SECRET` the request carries `Authorization: Bearer <secret>`.
- Visitors can resume a chat for 24 hours (reloads, other pages, coming back later).

## Widget options

Set them as `data-` attributes on the script tag or in `window.CHAT_CONFIG` before it:

| Attribute | `CHAT_CONFIG` key | Default | |
|---|---|---|---|
| `data-turnstile-site-key` | `turnstileSiteKey` | none | Needed when the Worker has `TURNSTILE_SECRET_KEY` |
| `data-color` | `color` | `#2563eb` | Accent color |
| `data-position` | `position` | `right` | `left` or `right` |
| `data-title`, `data-subtitle` | `texts.title`, `texts.subtitle` | "Chat with us" | Header text |
| `data-service-url` | `serviceUrl` | where `widget.js` comes from | Only if you host the script yourself |

All other labels can be changed through `texts`, for example to translate the widget:

```html
<script>
  window.CHAT_CONFIG = {
    turnstileSiteKey: '0x…',
    texts: { title: 'Schreiben Sie uns', placeholder: 'Ihre Nachricht…', send: 'Senden' },
  };
</script>
<script src="https://YOUR_WORKER.workers.dev/widget.js" defer></script>
```

The keys are listed at the top of [`public/widget.js`](public/widget.js). Messages written by the server (automatic replies, errors) are in [`src/texts.ts`](src/texts.ts).

Open the chat from your own link or button with `window.FreeLiveChat.open()`.

If your site has a Content Security Policy, allow your Worker in `script-src`, `connect-src` (https and wss) and `img-src`, and `https://challenges.cloudflare.com` in `script-src` and `frame-src` for Turnstile.

## Configuration

| Name | Where | |
|---|---|---|
| `SLACK_CHANNEL_ID` | `wrangler.jsonc` | Support channel ID |
| `ALLOWED_ORIGINS` | `wrangler.jsonc` | Exact origins that may embed the chat, comma-separated |
| `SLACK_BOT_TOKEN` | secret | Bot token (`xoxb-…`) |
| `SLACK_SIGNING_SECRET` | secret | Required: without it every Slack event is rejected |
| `TURNSTILE_SECRET_KEY` | secret | Required for new chats. Without it the Worker refuses them, unless you set `DISABLE_TURNSTILE` to `"true"` in `wrangler.jsonc` (then anyone can open chats from a script) |
| `TICKET_WEBHOOK_URL` | secret | Optional, receives the contact details (the old name `N8N_WEBHOOK_URL` still works) |
| `TICKET_WEBHOOK_SECRET` | secret | Optional, sent as a Bearer token to the webhook |

Timings, limits and retention are constants in [`src/config.ts`](src/config.ts). The per-IP limit for new chats (5 per minute) is the `ratelimits` block in `wrangler.jsonc`; if your account rejects it, delete the block and rely on Turnstile.

## Security and privacy

- New chats need a valid Turnstile token and are rate limited per IP (per /64 for IPv6). Only `/start` creates chats; a chat's random ID works like a password for its WebSocket, files and resumption. Within a chat, visitors can send 10 messages a minute and 300 in total.
- Slack events are accepted only with a valid signature that is at most five minutes old.
- Visitor text is escaped before it goes to Slack, so it cannot ping `@channel` or disguise links. The widget renders all messages as plain text with clickable `http(s)` links only.
- Uploads: allowed types only, file content must match the type, the extension is corrected, 10 MB and 10 files per chat. Downloads are served as attachments in a sandbox.
- Stored data: the transcript and contact details in the chat's Durable Object, the Slack thread link (and email, if given) in D1, files in R2. All of it is deleted 30 days after the chat started, or after 24 hours if the visitor never wrote anything. IP addresses are not stored. Slack keeps whatever was posted there under your workspace's retention settings.

## AI assistant (optional)

The assistant answers from your own question-and-answer list (RAG with Vectorize and Workers AI), hands sensitive topics like billing straight to a human and goes quiet once your team replies. Setup and tuning: [docs/AI_CHATBOT.md](docs/AI_CHATBOT.md).

## Development

```bash
cp .dev.vars.example .dev.vars   # local settings with Turnstile test keys
npm run db:migrate:local
npm run dev                      # test page: http://localhost:8787/demo
npm run check                    # types, tests (in the Workers runtime) and a build
```

Slack can only reach your machine through a tunnel, e.g. `cloudflared tunnel --url http://localhost:8787`; use that URL for the Event Subscriptions while testing.

```
src/
├── index.ts        Worker: routes, uploads, downloads, Slack webhook
├── ChatSession.ts  Durable Object: one chat, WebSockets, Slack thread, automatic replies, cleanup
├── slack.ts        Slack API, signature check, text conversion
├── files.ts        File type, content and name checks
├── http.ts         Origins, CORS, input limits, Turnstile
├── bot.ts          AI assistant
├── knowledge.ts    Knowledge base format (shared with scripts/)
├── prompts.ts      The assistant's prompt and handoff topics
├── texts.ts        Messages shown to visitors and posted to Slack
├── config.ts       Timings, limits, models
└── types.ts
public/widget.js    The embeddable widget
scripts/            Knowledge base upload and model comparison
test/               Vitest tests
```

## Upgrading from 1.0

- Run `npm run db:migrate`. It removes the old upload table, the IP addresses 1.0 stored and Slack thread links older than 30 days.
- `SLACK_SIGNING_SECRET` and `TURNSTILE_SECRET_KEY` are now required (or set `DISABLE_TURNSTILE` to `"true"`), and `ALLOWED_ORIGINS` must list every origin exactly (origins containing "localhost" are no longer let through automatically).
- If you wrote your own widget: `/upload/complete` now takes the file itself as the request body, with `sessionId` and `fileId` in the query string, and the response of `/upload/start` no longer contains `r2Key`. To resume a chat without opening a new one when it has expired, send `resumeOnly: true` to `/start` (answer: 404).
- Add the `files:write` scope (without it, visitor files never reached Slack) and `groups:history` for private channels, then reinstall the Slack app.
- The AI assistant is off until you uncomment the `ai` and `vectorize` blocks in `wrangler.jsonc`, and its knowledge base must be uploaded again (new embedding model).
- Download links of files sent before the upgrade stop working.

## License

MIT
