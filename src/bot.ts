/**
 * AI Bot module for automated customer support responses
 * Uses RAG (Retrieval Augmented Generation) with Vectorize
 */

import type { Env, ChatMessage } from './types';
import {
  SYSTEM_PROMPT,
  HANDOFF_KEYWORDS,
  HANDOFF_RESPONSES,
  LOW_CONFIDENCE_RESPONSE,
} from './prompts';

// Embedding model - Workers AI bge-base-en-v1.5 produces 768-dimensional vectors
// But we're using 1024 dimensions for the index, so we'll use bge-large-en-v1.5
const EMBEDDING_MODEL = '@cf/baai/bge-large-en-v1.5';

// Text generation model - Qwen 2.5 32B (general-purpose, no thinking leaks)
const TEXT_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';

// Confidence threshold - below this, defer to human
const CONFIDENCE_THRESHOLD = 0.5;

// Maximum context length for the LLM
const MAX_CONTEXT_LENGTH = 4000;

export interface BotResponse {
  content: string;
  confidence: number;
  needsHandoff: boolean;
  handoffReason?: string;
}

export interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: {
    kategorie?: string;
    kernfrage?: string;
    keywords?: string[];
    answer?: string;
    type?: string; // 'support' | 'pricing' | 'product'
    product?: string;
  };
}

/**
 * Check if the message contains keywords that require human intervention
 */
export function detectHandoffNeeded(message: string): { needed: boolean; reason?: string } {
  const lowerMessage = message.toLowerCase();

  for (const keyword of HANDOFF_KEYWORDS) {
    if (lowerMessage.includes(keyword)) {
      // Determine the category for the handoff response
      if (keyword.includes('rechnung')) {
        return { needed: true, reason: 'rechnung' };
      }
      if (keyword.includes('kündig')) {
        return { needed: true, reason: 'kündigung' };
      }
      if (keyword.includes('pausier') || keyword.includes('reaktiv')) {
        return { needed: true, reason: 'pausierung' };
      }
      if (
        keyword.includes('bank') ||
        keyword.includes('sepa') ||
        keyword.includes('lastschrift') ||
        keyword.includes('iban')
      ) {
        return { needed: true, reason: 'bankverbindung' };
      }
      return { needed: true, reason: 'default' };
    }
  }

  return { needed: false };
}

/**
 * Generate embedding for a text query
 */
export async function generateEmbedding(env: Env, text: string): Promise<number[]> {
  const result = await env.AI.run(EMBEDDING_MODEL, {
    text: [text],
  });

  // Workers AI embedding models return { shape: [...], data: [[...]] }
  // The type definitions may not match exactly, so we use type assertion
  const embedResult = result as unknown as {
    shape: number[];
    data: number[][];
  };

  if (embedResult.data && embedResult.data.length > 0) {
    return embedResult.data[0];
  }

  throw new Error('Failed to generate embedding');
}

/**
 * Query Vectorize for similar support scenarios
 */
export async function queryKnowledgeBase(
  env: Env,
  embedding: number[],
  topK: number = 3
): Promise<VectorizeMatch[]> {
  const results = await env.SUPPORT_INDEX.query(embedding, {
    topK,
    returnMetadata: 'all',
  });

  return results.matches.map((match) => ({
    id: match.id,
    score: match.score,
    metadata: match.metadata as VectorizeMatch['metadata'],
  }));
}

/**
 * Build context string from Vectorize matches
 */
export function buildContext(matches: VectorizeMatch[]): string {
  if (matches.length === 0) {
    return 'Keine relevanten Informationen gefunden.';
  }

  const contextParts: string[] = [];

  for (const match of matches) {
    if (!match.metadata) continue;

    const { type, kategorie, kernfrage, answer, product } = match.metadata;

    if (type === 'pricing' && product) {
      contextParts.push(`[Preis - ${product}]: ${kernfrage}`);
    } else if (type === 'product' && product) {
      contextParts.push(`[Produkt - ${product}]: ${kernfrage}`);
    } else if (kategorie && kernfrage) {
      let entry = `[${kategorie}]: ${kernfrage}`;
      if (answer) {
        entry += `\nAntwort: ${answer}`;
      }
      contextParts.push(entry);
    }
  }

  const context = contextParts.join('\n\n');

  // Truncate if too long
  if (context.length > MAX_CONTEXT_LENGTH) {
    return context.slice(0, MAX_CONTEXT_LENGTH) + '...';
  }

  return context;
}

/**
 * Build conversation history for the prompt
 */
export function buildConversationHistory(messages: ChatMessage[], maxMessages: number = 10): string {
  // Get the last N messages
  const recentMessages = messages.slice(-maxMessages);

  return recentMessages
    .map((msg) => {
      const sender =
        msg.role === 'customer' ? 'Kunde' : msg.role === 'bot' ? 'Assistent' : 'Mitarbeiter';
      return `${sender}: ${msg.content}`;
    })
    .join('\n');
}

/**
 * Generate a response using Workers AI
 */
export async function generateResponse(
  env: Env,
  context: string,
  conversationHistory: string,
  currentMessage: string
): Promise<string> {
  const systemPrompt = SYSTEM_PROMPT.replace('{context}', context);

  const userPrompt = conversationHistory
    ? `Bisheriger Verlauf:\n${conversationHistory}\n\nAktuelle Nachricht des Kunden:\n${currentMessage}`
    : `Nachricht des Kunden:\n${currentMessage}`;

  const result = await env.AI.run(TEXT_MODEL, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 500,
    temperature: 0.7,
  });

  // Handle the response format from Workers AI
  if (typeof result === 'object' && 'response' in result) {
    return (result as { response: string }).response;
  }

  throw new Error('Unexpected response format from AI model');
}

/**
 * Main function to generate a bot response
 */
export async function generateBotResponse(
  env: Env,
  messages: ChatMessage[],
  currentMessage: string
): Promise<BotResponse> {
  // First, check if handoff is needed based on keywords
  const handoffCheck = detectHandoffNeeded(currentMessage);
  if (handoffCheck.needed) {
    const response =
      HANDOFF_RESPONSES[handoffCheck.reason || 'default'] || HANDOFF_RESPONSES.default;
    return {
      content: response,
      confidence: 1.0, // High confidence that handoff is needed
      needsHandoff: true,
      handoffReason: handoffCheck.reason,
    };
  }

  try {
    // Generate embedding for the current message + recent context
    const recentContext = messages
      .slice(-3)
      .map((m) => m.content)
      .join(' ');
    const queryText = `${currentMessage} ${recentContext}`.slice(0, 500);
    const embedding = await generateEmbedding(env, queryText);

    // Query knowledge base
    const matches = await queryKnowledgeBase(env, embedding, 3);

    // Check confidence based on top match score
    const topScore = matches.length > 0 ? matches[0].score : 0;

    if (topScore < CONFIDENCE_THRESHOLD) {
      return {
        content: LOW_CONFIDENCE_RESPONSE,
        confidence: topScore,
        needsHandoff: true,
        handoffReason: 'low_confidence',
      };
    }

    // Build context from matches
    const context = buildContext(matches);

    // Build conversation history
    const conversationHistory = buildConversationHistory(messages);

    // Generate response
    const responseContent = await generateResponse(
      env,
      context,
      conversationHistory,
      currentMessage
    );

    return {
      content: responseContent,
      confidence: topScore,
      needsHandoff: false,
    };
  } catch (error) {
    console.error('[Bot] Error generating response:', error);

    // Fallback to handoff on error
    return {
      content: LOW_CONFIDENCE_RESPONSE,
      confidence: 0,
      needsHandoff: true,
      handoffReason: 'error',
    };
  }
}
