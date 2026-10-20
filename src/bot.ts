/**
 * Optional AI bot: answers visitors from your knowledge base (RAG with Vectorize + Workers AI)
 * until a team member replies in Slack. Off unless the AI and SUPPORT_INDEX bindings exist.
 */

import type { ChatMessage, Env } from './types';
import {
  BOT_MAX_HISTORY_MESSAGES,
  BOT_MAX_REPLIES_PER_CHAT,
  BOT_MAX_REPLY_CHARS,
  CONFIDENCE_THRESHOLD,
  EMBEDDING_MODEL,
  TEXT_MODEL,
  TEXT_MODEL_OPTIONS,
} from './config';
import { buildContext, type KnowledgeMetadata } from './knowledge';
import { HANDOFF_TOPICS, LOW_CONFIDENCE_RESPONSE, buildSystemPrompt, contactLines } from './prompts';

export interface BotResponse {
  content: string;
  /** Similarity score of the best knowledge base match (1 for keyword handoffs). */
  confidence: number;
  needsHandoff: boolean;
  handoffReason?: string;
}

type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export function isBotEnabled(env: Env): boolean {
  return Boolean(env.AI && env.SUPPORT_INDEX);
}

/** The first handoff topic whose keyword starts a word in `text`. */
export function detectHandoff(text: string): { id: string; response: string } | null {
  const lower = text.toLowerCase();
  for (const topic of HANDOFF_TOPICS) {
    if (topic.keywords.some((keyword) => containsWordStart(lower, keyword.toLowerCase()))) {
      return { id: topic.id, response: topic.response };
    }
  }
  return null;
}

function containsWordStart(text: string, keyword: string): boolean {
  for (let index = text.indexOf(keyword); index !== -1; index = text.indexOf(keyword, index + 1)) {
    if (index === 0 || !/[\p{L}\p{N}]/u.test(text[index - 1])) return true;
  }
  return false;
}

/** Visitor messages the bot has not answered yet (they are answered together). */
export function unansweredVisitorText(messages: ChatMessage[]): string {
  const lastBotIndex = messages.findLastIndex((m) => m.role !== 'customer');
  return messages
    .slice(lastBotIndex + 1)
    .map((m) => m.content)
    .filter(Boolean)
    .join('\n');
}

/**
 * The conversation as chat turns, so the model can tell the visitor's words from its own.
 * Consecutive visitor messages are merged into one turn.
 */
export function buildModelMessages(systemPrompt: string, history: ChatMessage[]): ModelMessage[] {
  const turns: ModelMessage[] = [];
  for (const message of history.filter((m) => m.content).slice(-BOT_MAX_HISTORY_MESSAGES)) {
    const role = message.role === 'customer' ? 'user' : 'assistant';
    const previous = turns[turns.length - 1];
    if (previous?.role === role) previous.content += `\n${message.content}`;
    else turns.push({ role, content: message.content });
  }
  // Chat models expect the conversation to start with the user
  while (turns[0]?.role === 'assistant') turns.shift();
  return [{ role: 'system', content: systemPrompt }, ...turns];
}

/** Removes reasoning blocks and trims overly long replies at a sentence boundary. */
export function cleanReply(text: string): string {
  let reply = text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();
  if (reply.length > BOT_MAX_REPLY_CHARS) {
    const cut = reply.slice(0, BOT_MAX_REPLY_CHARS);
    const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));
    reply = sentenceEnd > BOT_MAX_REPLY_CHARS / 2 ? cut.slice(0, sentenceEnd + 1).trim() : `${cut.trim()}…`;
  }
  return reply;
}

/**
 * True if the reply contains a link, email address or phone number that is neither in the
 * knowledge base entries nor in CONTACT_INFO. Models like to invent plausible ones.
 */
export function hasUnverifiedDetails(reply: string, sources: string): boolean {
  const known = sources.toLowerCase();
  const knownDigits = sources.replace(/\D/g, '');
  const links = reply.match(/https?:\/\/[^\s<>"'()]+/g) ?? [];
  if (links.some((link) => !known.includes(link.replace(/[.,;:!?]+$/, '').toLowerCase()))) return true;
  const emails = reply.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
  if (emails.some((email) => !known.includes(email.toLowerCase()))) return true;
  const phones = reply.match(/\+?\d[\d ()./-]{5,}\d/g) ?? [];
  return phones.some((phone) => {
    const digits = phone.replace(/\D/g, '');
    return digits.length >= 6 && !knownDigits.includes(digits);
  });
}

async function embed(ai: Ai, text: string): Promise<number[]> {
  const result = (await ai.run(EMBEDDING_MODEL, { text: [text] })) as { data?: number[][] };
  const vector = result.data?.[0];
  if (!vector) throw new Error('Embedding model returned no vector');
  return vector;
}

async function generateText(ai: Ai, messages: ModelMessage[]): Promise<string> {
  const result = (await ai.run(TEXT_MODEL, { messages, max_tokens: 400, temperature: 0.3, ...TEXT_MODEL_OPTIONS })) as {
    // Older models answer with `response`, newer ones in the OpenAI Chat Completions shape
    response?: unknown;
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  if (typeof result.response === 'string') return result.response;
  const content = result.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  throw new Error('Unexpected response format from the text model');
}

/** Never throws: on any problem the bot hands the chat over to a human. */
export async function generateBotResponse(env: Env, messages: ChatMessage[], repliesSoFar = 0): Promise<BotResponse> {
  const question = unansweredVisitorText(messages);
  if (repliesSoFar >= BOT_MAX_REPLIES_PER_CHAT) {
    return { content: LOW_CONFIDENCE_RESPONSE, confidence: 0, needsHandoff: true, handoffReason: 'reply_limit' };
  }

  const handoff = detectHandoff(question);
  if (handoff) {
    return { content: handoff.response, confidence: 1, needsHandoff: true, handoffReason: handoff.id };
  }
  if (!env.AI || !env.SUPPORT_INDEX) {
    return { content: LOW_CONFIDENCE_RESPONSE, confidence: 0, needsHandoff: true, handoffReason: 'disabled' };
  }

  try {
    // A short follow-up ("and how much is it?") needs the previous messages to find the right entries
    const query = messages
      .filter((m) => m.role === 'customer' && m.content)
      .slice(-3)
      .map((m) => m.content)
      .join('\n');
    const embedding = await embed(env.AI, query.slice(-1000));
    const { matches } = await env.SUPPORT_INDEX.query(embedding, { topK: 3, returnMetadata: 'all' });
    const topScore = matches[0]?.score ?? 0;
    if (topScore < CONFIDENCE_THRESHOLD) {
      return { content: LOW_CONFIDENCE_RESPONSE, confidence: topScore, needsHandoff: true, handoffReason: 'low_confidence' };
    }

    const context = buildContext(matches.map((m) => ({ metadata: m.metadata as KnowledgeMetadata | undefined })));
    const reply = cleanReply(await generateText(env.AI, buildModelMessages(buildSystemPrompt(context), messages)));
    if (!reply) {
      return { content: LOW_CONFIDENCE_RESPONSE, confidence: topScore, needsHandoff: true, handoffReason: 'empty_reply' };
    }
    if (hasUnverifiedDetails(reply, `${context}\n${contactLines().join('\n')}`)) {
      return { content: LOW_CONFIDENCE_RESPONSE, confidence: topScore, needsHandoff: true, handoffReason: 'unverified_details' };
    }
    return { content: reply, confidence: topScore, needsHandoff: false };
  } catch (error) {
    console.error('[bot] Generating a reply failed:', error);
    return { content: LOW_CONFIDENCE_RESPONSE, confidence: 0, needsHandoff: true, handoffReason: 'error' };
  }
}
