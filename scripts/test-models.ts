#!/usr/bin/env npx tsx
/**
 * Compares chat models on your knowledge base: same question, same retrieved entries, side by side.
 * Also prints the similarity scores, which helps to tune CONFIDENCE_THRESHOLD in src/config.ts.
 *
 * Usage:
 *   npm run models:test                                   interactive
 *   npm run models:test -- "How long does shipping take?" one question
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI + Vectorize) and a filled index
 * (npm run embeddings:prepare). ANTHROPIC_API_KEY and GOOGLE_API_KEY add Claude and Gemini for
 * comparison; the bot itself only runs on Workers AI.
 */

import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { EMBEDDING_MODEL, TEXT_MODEL, TEXT_MODEL_OPTIONS } from '../src/config.js';
import { buildContext, type KnowledgeMetadata } from '../src/knowledge.js';
import { buildSystemPrompt } from '../src/prompts.js';

const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, ANTHROPIC_API_KEY, GOOGLE_API_KEY } = process.env;
const INDEX_NAME = process.env.VECTORIZE_INDEX ?? 'support-knowledge-base';

type Turn = { role: 'user' | 'assistant'; content: string };

interface Model {
  name: string;
  provider: 'workers-ai' | 'anthropic' | 'google';
  id: string;
  options?: Record<string, unknown>;
}

// Model IDs checked against the providers' model lists on 2026-10-20
const MODELS: Model[] = [
  { name: 'Gemma 4 26B (bot default)', provider: 'workers-ai', id: TEXT_MODEL, options: TEXT_MODEL_OPTIONS },
  { name: 'Mistral Small 3.1 24B', provider: 'workers-ai', id: '@cf/mistralai/mistral-small-3.1-24b-instruct' },
  { name: 'Llama 4 Scout 17B', provider: 'workers-ai', id: '@cf/meta/llama-4-scout-17b-16e-instruct' },
  { name: 'Claude Haiku 5.5 (paid API)', provider: 'anthropic', id: 'claude-haiku-5-5' },
  { name: 'Gemini 3.8 Flash (paid API)', provider: 'google', id: 'gemini-3.8-flash' },
];

async function cloudflare<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as { success: boolean; result: T; errors?: unknown };
  if (!response.ok || !result.success) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(result.errors)}`);
  return result.result;
}

async function retrieve(question: string) {
  const { data } = await cloudflare<{ data: number[][] }>(`/ai/run/${EMBEDDING_MODEL}`, { text: [question] });
  const { matches } = await cloudflare<{ matches: Array<{ id: string; score: number; metadata?: KnowledgeMetadata }> }>(
    `/vectorize/v2/indexes/${INDEX_NAME}/query`,
    { vector: data[0], topK: 3, returnMetadata: 'all' }
  );
  return matches;
}

async function ask(model: Model, system: string, turns: Turn[]): Promise<string> {
  if (model.provider === 'workers-ai') {
    const result = await cloudflare<{ response?: string; choices?: Array<{ message?: { content?: string } }> }>(
      `/ai/run/${model.id}`,
      { messages: [{ role: 'system', content: system }, ...turns], max_tokens: 400, temperature: 0.3, ...model.options }
    );
    const text = result.response ?? result.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty response');
    return text;
  }

  if (model.provider === 'anthropic') {
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model.id, max_tokens: 400, system, messages: turns }),
    });
    const result = (await response.json()) as { content?: Array<{ type: string; text: string }>; error?: { message: string } };
    if (result.error) throw new Error(result.error.message);
    return result.content?.find((block) => block.type === 'text')?.text ?? '';
  }

  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY not set');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': GOOGLE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: turns.map((turn) => ({ role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.content }] })),
      generationConfig: { maxOutputTokens: 400 },
    }),
  });
  const result = (await response.json()) as {
    candidates?: Array<{ content: { parts: Array<{ text?: string }> } }>;
    error?: { message: string };
  };
  if (result.error) throw new Error(result.error.message);
  return result.candidates?.[0]?.content.parts.map((part) => part.text ?? '').join('') ?? '';
}

async function compare(models: Model[], turns: Turn[]): Promise<void> {
  const question = turns[turns.length - 1].content;
  const matches = await retrieve(question);
  console.log('\nKnowledge base matches:');
  for (const match of matches) {
    console.log(`  ${match.score.toFixed(3)}  ${match.metadata?.question ?? match.id}`);
  }
  const system = buildSystemPrompt(buildContext(matches));

  for (const model of models) {
    const started = Date.now();
    try {
      const reply = await ask(model, system, turns);
      console.log(`\n── ${model.name} (${Date.now() - started} ms)\n${reply.trim()}`);
      if (models.length === 1) turns.push({ role: 'assistant', content: reply.trim() });
    } catch (error) {
      console.log(`\n── ${model.name}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

async function main() {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN first.');
    process.exit(1);
  }

  const single = process.argv[2];
  if (single) {
    await compare(MODELS, [{ role: 'user', content: single }]);
    return;
  }

  console.log('Models:');
  MODELS.forEach((model, i) => console.log(`  ${i + 1}. ${model.name}`));
  console.log('\nType a question to compare all models, "chat <n>" to talk to one model with history,');
  console.log('"/reset" to clear the history, "/all" to compare again, "quit" to exit.\n');

  const rl = readline.createInterface({ input: stdin, output: stdout });
  let chatModel: Model | null = null;
  let turns: Turn[] = [];
  for (;;) {
    const input = (await rl.question(chatModel ? `[${chatModel.name}] > ` : '> ')).trim();
    if (!input) continue;
    if (input === 'quit' || input === 'q') break;
    if (input === '/reset') {
      turns = [];
      continue;
    }
    if (input === '/all') {
      chatModel = null;
      turns = [];
      continue;
    }
    const pick = /^chat (\d+)$/.exec(input);
    if (pick) {
      chatModel = MODELS[Number(pick[1]) - 1] ?? null;
      turns = [];
      if (!chatModel) console.log(`Pick a number between 1 and ${MODELS.length}.`);
      continue;
    }

    const conversation: Turn[] = chatModel ? turns : [];
    conversation.push({ role: 'user', content: input });
    try {
      await compare(chatModel ? [chatModel] : MODELS, conversation);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    console.log('');
  }
  rl.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
