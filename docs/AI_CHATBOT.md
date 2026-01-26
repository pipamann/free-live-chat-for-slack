# AI Chatbot

Optional AI assistant that responds to customers using RAG (Retrieval Augmented Generation) with Cloudflare Vectorize.

## Architecture

- **Model:** `@cf/qwen/qwen2.5-coder-32b-instruct` (Workers AI, free tier)
- **Embeddings:** `@cf/baai/bge-large-en-v1.5` (1024 dimensions)
- **Knowledge base:** Cloudflare Vectorize index

## Key Files

| File | Purpose |
|------|---------|
| `src/bot.ts` | RAG logic, embedding, response generation |
| `src/prompts.ts` | System prompt, handoff keywords (customize this!) |
| `scripts/prepare-embeddings.ts` | Build/update knowledge base |
| `scripts/test-models.ts` | Compare AI models interactively |

## Behavior

1. **Greets user** on first message
2. **Adapts** to user's technical level (simple by default)
3. **Explains WHY** problems occur, not just solutions
4. **Hands off** to staff for sensitive requests (billing, cancellation, etc.)
5. **Asks for email** during handoff so staff can follow up
6. **Extracts email** automatically from customer messages
7. **Disables itself** when staff replies in Slack

## Customization

### Bot Personality

Edit `src/prompts.ts`:

```typescript
export const BOT_CONFIG = {
  productName: 'Your Product',  // Your product name
  botName: 'AI Assistant',      // Display name
  language: 'en',               // Response language
  dashboardUrl: 'https://...',  // Your dashboard URL
};
```

### Handoff Keywords

Add keywords that should trigger human escalation:

```typescript
export const HANDOFF_KEYWORDS = [
  'refund',
  'cancel',
  'billing',
  // ... add your own
];
```

### Response Templates

Customize what the bot says during handoff:

```typescript
export const HANDOFF_RESPONSES = {
  invoice: 'For invoice requests, I need to involve a team member...',
  cancel: 'For cancellation requests...',
  default: 'I\'ll forward your request to our team...',
};
```

## Model Choice

**Why Qwen 2.5?**
- Free on Workers AI
- Clean output (no thinking tokens leaked)
- Good multilingual support
- Fast inference

**Alternatives tested:**
- QwQ and DeepSeek R1 leak `<think>` tokens
- Llama models work but Qwen performs better for support

## Updating Knowledge Base

1. Create JSON files with your Q&A content
2. Update `scripts/prepare-embeddings.ts` to read your data format
3. Run the script:

```bash
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
export CLOUDFLARE_API_TOKEN="your-api-token"
npm run embeddings:prepare
```

## Testing Models

Compare different AI models with the same question:

```bash
npm run models:test

# Interactive commands:
#   <question>   Compare all models
#   chat <n>     Single-model conversation with history
#   /exit        Back to comparison mode
```

## Disabling AI

To run without AI, simply don't create the Vectorize index. The chat will work as a direct Slack bridge without the AI layer.
