#!/usr/bin/env npx tsx
/**
 * Prepare embeddings for the Vectorize knowledge base
 *
 * This is an EXAMPLE script. Customize it to read your own data format.
 *
 * Usage:
 *   CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_API_TOKEN=xxx npx tsx scripts/prepare-embeddings.ts
 *
 * Prerequisites:
 *   - wrangler login (or CLOUDFLARE_API_TOKEN env var)
 *   - Vectorize index created: npm run vectorize:create
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

// Cloudflare configuration
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const INDEX_NAME = 'support-knowledge-base';

// Embedding model dimensions (bge-large-en-v1.5 produces 1024-dim vectors)
const EMBEDDING_DIMENSIONS = 1024;

interface KnowledgeEntry {
  id: string;
  question: string;
  answer: string;
  category?: string;
  keywords?: string[];
}

interface VectorMetadata {
  type: 'faq' | 'product' | 'general';
  category?: string;
  question?: string;
  answer?: string;
  keywords?: string[];
}

interface VectorRecord {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

/**
 * CUSTOMIZE THIS: Load your knowledge base data
 *
 * Example format (data/knowledge/*.json):
 * [
 *   {
 *     "id": "faq-1",
 *     "question": "How do I reset my password?",
 *     "answer": "Go to Settings > Security > Reset Password...",
 *     "category": "Account",
 *     "keywords": ["password", "reset", "login"]
 *   }
 * ]
 */
function loadKnowledgeBase(): KnowledgeEntry[] {
  const knowledgeDir = join(PROJECT_ROOT, 'data', 'knowledge');
  const entries: KnowledgeEntry[] = [];

  if (!existsSync(knowledgeDir)) {
    console.log(`Knowledge directory not found: ${knowledgeDir}`);
    console.log('Create data/knowledge/*.json files with your Q&A content.');
    console.log('\nExample format:');
    console.log(
      JSON.stringify(
        [
          {
            id: 'faq-1',
            question: 'How do I reset my password?',
            answer: 'Go to Settings > Security > Reset Password...',
            category: 'Account',
            keywords: ['password', 'reset', 'login'],
          },
        ],
        null,
        2
      )
    );
    return [];
  }

  try {
    const files = readdirSync(knowledgeDir).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      console.log(`Reading ${file}...`);
      const content = readFileSync(join(knowledgeDir, file), 'utf-8');
      const data: KnowledgeEntry[] = JSON.parse(content);
      entries.push(...data);
    }

    console.log(`Loaded ${entries.length} knowledge entries`);
    return entries;
  } catch (error) {
    console.error('Error loading knowledge base:', error);
    return [];
  }
}

/**
 * Generate embedding using Cloudflare Workers AI API
 */
async function generateEmbedding(text: string): Promise<number[]> {
  if (!ACCOUNT_ID || !API_TOKEN) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set');
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/@cf/baai/bge-large-en-v1.5`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: [text],
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Embedding API error: ${response.status} - ${error}`);
  }

  const result = (await response.json()) as {
    success: boolean;
    result?: { data: number[][] };
    errors?: unknown[];
  };

  if (!result.success || !result.result?.data?.[0]) {
    throw new Error(`Embedding failed: ${JSON.stringify(result.errors)}`);
  }

  return result.result.data[0];
}

/**
 * Upload vectors to Vectorize
 */
async function uploadVectors(vectors: VectorRecord[]): Promise<void> {
  if (!ACCOUNT_ID || !API_TOKEN) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set');
  }

  // Vectorize API expects NDJSON format
  const ndjson = vectors.map((v) => JSON.stringify(v)).join('\n');

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/upsert`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/x-ndjson',
      },
      body: ndjson,
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Vectorize API error: ${response.status} - ${error}`);
  }

  const result = (await response.json()) as { success: boolean; errors?: unknown[] };
  if (!result.success) {
    throw new Error(`Vectorize upsert failed: ${JSON.stringify(result.errors)}`);
  }
}

/**
 * Main function
 */
async function main() {
  console.log('=== Knowledge Base Embedding Builder ===\n');

  // Check environment
  if (!ACCOUNT_ID || !API_TOKEN) {
    console.error('Error: Please set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    console.log('\nExample:');
    console.log(
      '  CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_API_TOKEN=xxx npx tsx scripts/prepare-embeddings.ts'
    );
    process.exit(1);
  }

  // Load data
  const entries = loadKnowledgeBase();

  if (entries.length === 0) {
    console.error('\nNo knowledge base entries found.');
    console.log('Create data/knowledge/*.json files with your Q&A content.');
    process.exit(1);
  }

  const vectors: VectorRecord[] = [];
  let processed = 0;

  // Process entries
  console.log('\n--- Processing knowledge entries ---');
  for (const entry of entries) {
    try {
      // Combine question with keywords for better embedding
      const textToEmbed = entry.keywords
        ? `${entry.question} ${entry.keywords.join(' ')}`
        : entry.question;

      const embedding = await generateEmbedding(textToEmbed);

      vectors.push({
        id: entry.id,
        values: embedding,
        metadata: {
          type: 'faq',
          category: entry.category,
          question: entry.question,
          answer: entry.answer,
          keywords: entry.keywords,
        },
      });

      processed++;
      if (processed % 10 === 0 || processed === entries.length) {
        console.log(`Progress: ${processed}/${entries.length} (${Math.round((processed / entries.length) * 100)}%)`);
      }

      // Rate limit: 1 request per 100ms
      await new Promise((r) => setTimeout(r, 100));
    } catch (error) {
      console.error(`Error processing entry ${entry.id}:`, error);
    }
  }

  // Upload to Vectorize in batches
  console.log(`\n--- Uploading ${vectors.length} vectors to Vectorize ---`);
  const BATCH_SIZE = 100;

  for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
    const batch = vectors.slice(i, i + BATCH_SIZE);
    console.log(
      `Uploading batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(vectors.length / BATCH_SIZE)}...`
    );

    try {
      await uploadVectors(batch);
    } catch (error) {
      console.error(`Error uploading batch:`, error);
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('\n=== Done! ===');
  console.log(`Total vectors uploaded: ${vectors.length}`);
}

// Run main
main().catch(console.error);
