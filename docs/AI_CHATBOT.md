# AI assistant (optional)

The assistant answers visitors from your own list of questions and answers until someone from your team replies in Slack. It is off by default; without it, visitors get the automatic "checking availability" message and, after 30 seconds, the contact form.

## How it answers

1. A visitor writes. The assistant waits two seconds for follow-up messages.
2. Messages about billing, account changes, payment details or "call me" requests go straight to a human (keyword list in `src/prompts.ts`). The assistant says so and the contact form appears.
3. Otherwise the last visitor messages are turned into an embedding (`@cf/baai/bge-m3`, 100+ languages) and the three closest entries are looked up in Vectorize.
4. If even the best entry is not similar enough (`CONFIDENCE_THRESHOLD`), the assistant hands over instead of guessing.
5. Otherwise the chat model (`@cf/google/gemma-4-26b-a4b-it`) writes a short answer from those entries, in the visitor's language.
6. The answer appears in the chat (labelled as the assistant) and in the Slack thread with a 🤖. As soon as a team member replies, the assistant stops for this chat.

If anything fails (model unavailable, daily allowance used up, empty answer) the assistant hands over to your team instead of showing an error.

## Setup

1. In `wrangler.jsonc`, uncomment the `ai` and `vectorize` blocks.
2. Create the index (1024 dimensions, cosine similarity):
   ```bash
   npm run vectorize:create
   ```
3. In `src/prompts.ts`, set `BOT_CONFIG` (product and assistant name) and `CONTACT_INFO`. The assistant only ever gives out the contact details listed there; language models like to invent plausible phone numbers otherwise. Adjust the keyword lists in `HANDOFF_TOPICS` to your business.
4. Write your knowledge base as JSON files in `data/knowledge/` (format: [knowledge-example.json](knowledge-example.json)). One entry per question; keep answers short and self-contained, with full `https://` links.
5. Upload it, with an API token that has the "Workers AI: Read" and "Vectorize: Edit" permissions:
   ```bash
   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run embeddings:prepare
   ```
   Run it again after every change; entries with the same `id` are replaced.
6. `npm run deploy`.

## Tuning

```bash
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run models:test
```

Type a question to see the matching entries with their similarity scores and the answers of several models side by side; `chat 1` talks to one model with history. With `ANTHROPIC_API_KEY` or `GOOGLE_API_KEY` set it also asks Claude or Gemini for comparison (the assistant itself only runs on Workers AI).

- **`CONFIDENCE_THRESHOLD`** (`src/config.ts`): ask questions your entries do and do not cover and note the top scores. Set the threshold between the two groups. Higher means the assistant hands over more often.
- **`TEXT_MODEL`** and **`TEXT_MODEL_OPTIONS`** (`src/config.ts`): change them together. Gemma 4 has a "thinking" mode that is switched off; reasoning models that cannot switch it off spend most of their token budget before the answer.
- **`EMBEDDING_MODEL`**: if you change it, delete and recreate the index with the new model's dimensions and upload the knowledge base again.

## Safety

- The rules at the top of the system prompt tell the model to answer only from the knowledge base, never to invent prices, contact details or promises, and to treat chat messages as questions, not instructions. Keep them when you rewrite the prompt.
- That reduces but cannot rule out wrong or off-topic answers, so: the assistant has no tools and no access to customer data, its answers are short and labelled, and your team sees every answer in Slack.
- Put nothing into the knowledge base or prompt that a visitor must not see.

## Costs on the free plan

- **Workers AI:** 10,000 neurons per day. An answer costs roughly 25 to 40 neurons (the prompt with three entries and the recent messages, plus a short reply); embeddings cost almost nothing. That is a few hundred answers a day.
- **Vectorize:** 5 million stored dimensions, so about 4,800 entries at 1024 dimensions, and 30 million queried dimensions per month (with 500 entries that is about 28,000 questions a month).

## Turning it off

Comment the `ai` and `vectorize` blocks out again and deploy. Open chats switch to the automatic messages.
