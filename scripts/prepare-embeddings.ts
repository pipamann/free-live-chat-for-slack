#!/usr/bin/env npx tsx
/**
 * Uploads your knowledge base to Vectorize so the AI bot can answer from it.
 *
 * Put one or more JSON files into data/knowledge/, each an array of entries
 * (see docs/knowledge-example.json):
 *   [{ "id": "shipping-time", "category": "Shipping", "question": "…", "answer": "…" }]
 *
 * Usage:
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run embeddings:prepare
 *
 * The API token needs the "Workers AI: Read" and "Vectorize: Edit" permissions.
 * Running it again is safe: an entry with the same id replaces the old one.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../src/config.js';
import type { KnowledgeEntry, KnowledgeMetadata } from '../src/knowledge.js';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const INDEX_NAME = process.env.VECTORIZE_INDEX ?? 'support-knowledge-base';
const KNOWLEDGE_DIR = join(import.meta.dirname, '..', 'data', 'knowledge');
const BATCH_SIZE = 50;
/** The Vectorize free plan stores 5 million dimensions, i.e. this many vectors. */
const FREE_PLAN_MAX_VECTORS = Math.floor(5_000_000 / EMBEDDING_DIMENSIONS);
/** bge-m3 reliably handles about 512 tokens; longer text is cut. */
const MAX_EMBED_CHARS = 1500;
/** Vectorize allows 10 KiB of metadata per vector. */
const MAX_ANSWER_CHARS = 4000;

async function cloudflare<T>(path: string, body: string, contentType: string): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': contentType },
    body,
  });
  const result = (await response.json()) as { success: boolean; result: T; errors?: unknown };
  if (!response.ok || !result.success) {
    throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(result.errors)}`);
  }
  return result.result;
}

function loadEntries(): KnowledgeEntry[] {
  if (!existsSync(KNOWLEDGE_DIR)) {
    console.error(`No ${KNOWLEDGE_DIR} folder. Create it and add JSON files (see docs/knowledge-example.json).`);
    process.exit(1);
  }

  const entries: KnowledgeEntry[] = [];
  const seen = new Set<string>();
  for (const file of readdirSync(KNOWLEDGE_DIR).filter((name) => name.endsWith('.json'))) {
    const data: unknown = JSON.parse(readFileSync(join(KNOWLEDGE_DIR, file), 'utf-8'));
    if (!Array.isArray(data)) throw new Error(`${file}: expected an array of entries`);
    for (const [index, entry] of data.entries()) {
      const where = `${file}[${index}]`;
      if (typeof entry?.id !== 'string' || !entry.id || new TextEncoder().encode(entry.id).length > 64) {
        throw new Error(`${where}: "id" must be a string of at most 64 bytes`);
      }
      if (typeof entry.question !== 'string' || typeof entry.answer !== 'string' || !entry.question || !entry.answer) {
        throw new Error(`${where}: "question" and "answer" are required`);
      }
      if (seen.has(entry.id)) throw new Error(`${where}: duplicate id "${entry.id}"`);
      seen.add(entry.id);
      entries.push(entry);
    }
    console.log(`Read ${file}`);
  }
  return entries;
}

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN) {
    console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN first.');
    process.exit(1);
  }

  const entries = loadEntries();
  if (entries.length === 0) {
    console.error('No entries found.');
    process.exit(1);
  }
  console.log(`${entries.length} entries, embedding with ${EMBEDDING_MODEL} into "${INDEX_NAME}"`);
  if (entries.length > FREE_PLAN_MAX_VECTORS) {
    console.warn(`Warning: the Vectorize free plan holds about ${FREE_PLAN_MAX_VECTORS} vectors of this size.`);
  }

  for (let start = 0; start < entries.length; start += BATCH_SIZE) {
    const batch = entries.slice(start, start + BATCH_SIZE);
    const texts = batch.map((entry) => `${entry.question}\n${entry.answer}`.slice(0, MAX_EMBED_CHARS));
    const { data } = await cloudflare<{ data: number[][] }>(
      `/ai/run/${EMBEDDING_MODEL}`,
      JSON.stringify({ text: texts }),
      'application/json'
    );

    const ndjson = batch
      .map((entry, i) => {
        const metadata: KnowledgeMetadata = {
          category: entry.category,
          question: entry.question,
          answer: entry.answer.slice(0, MAX_ANSWER_CHARS),
        };
        return JSON.stringify({ id: entry.id, values: data[i], metadata });
      })
      .join('\n');
    await cloudflare(`/vectorize/v2/indexes/${INDEX_NAME}/upsert`, ndjson, 'application/x-ndjson');
    console.log(`Uploaded ${Math.min(start + BATCH_SIZE, entries.length)}/${entries.length}`);
  }

  console.log('Done. Vectorize applies the changes within a few seconds.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
