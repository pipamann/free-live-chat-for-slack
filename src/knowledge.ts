/**
 * The knowledge base format: what scripts/prepare-embeddings.ts stores with each vector and the bot reads.
 * Keep this file free of Workers-only types: scripts/ import it too.
 */

import { BOT_MAX_CONTEXT_CHARS } from './config';

/** One entry of data/knowledge/*.json. */
export interface KnowledgeEntry {
  /** Stable ID (at most 64 bytes). Uploading an entry with the same ID replaces it. */
  id: string;
  question: string;
  answer: string;
  category?: string;
}

/** Metadata stored with each vector in Vectorize. */
export type KnowledgeMetadata = Partial<Pick<KnowledgeEntry, 'category' | 'question' | 'answer'>>;

/** Turns the matched entries into the "Knowledge base" section of the bot's prompt. */
export function buildContext(matches: Array<{ metadata?: KnowledgeMetadata | null }>): string {
  const entries = matches
    .map(({ metadata }) => {
      if (!metadata?.answer && !metadata?.question) return '';
      return [
        metadata.category ? `[${metadata.category}]` : '',
        metadata.question ? `Q: ${metadata.question}` : '',
        metadata.answer ? `A: ${metadata.answer}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .filter(Boolean);
  return entries.join('\n\n').slice(0, BOT_MAX_CONTEXT_CHARS);
}
