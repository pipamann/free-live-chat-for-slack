#!/usr/bin/env npx tsx
/**
 * Test AI models with RAG context
 *
 * This script tests different AI models with the same RAG context
 * to compare quality, speed, and cost for customer support responses.
 *
 * Usage:
 *   npx tsx scripts/test-models.ts
 *   npx tsx scripts/test-models.ts "How do I reset my password?"
 *
 * Prerequisites:
 *   - CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for Workers AI
 *   - ANTHROPIC_API_KEY for Claude (optional)
 *   - GOOGLE_API_KEY for Gemini (optional)
 *   - Vectorize index populated: npm run embeddings:prepare
 */

import * as readline from 'readline';
import { SYSTEM_PROMPT } from '../src/prompts.js';

// Environment variables
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

const VECTORIZE_INDEX = 'support-knowledge-base';

interface ModelConfig {
  name: string;
  provider: 'workers-ai' | 'anthropic' | 'google';
  modelId: string;
  costPerQuery: string;
}

const MODELS: ModelConfig[] = [
  {
    name: 'Qwen 2.5 32B (Workers AI - Free)',
    provider: 'workers-ai',
    modelId: '@cf/qwen/qwen2.5-coder-32b-instruct',
    costPerQuery: '$0.00',
  },
  {
    name: 'Claude Sonnet 4',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-20250514',
    costPerQuery: '~$0.003',
  },
  {
    name: 'Claude Haiku 3.5',
    provider: 'anthropic',
    modelId: 'claude-3-5-haiku-20241022',
    costPerQuery: '~$0.001',
  },
  {
    name: 'Gemini 2.0 Flash',
    provider: 'google',
    modelId: 'gemini-2.0-flash',
    costPerQuery: '~$0.0001',
  },
];

interface VectorMatch {
  id: string;
  score: number;
  metadata?: {
    category?: string;
    question?: string;
    answer?: string;
    keywords?: string[];
    type?: string;
  };
}

interface TestResult {
  model: string;
  response: string;
  timeMs: number;
  cost: string;
  error?: string;
}

/**
 * Generate embedding using Cloudflare Workers AI
 */
async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/baai/bge-large-en-v1.5`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: [text] }),
    }
  );

  const result = (await response.json()) as {
    success: boolean;
    result?: { data: number[][] };
  };

  if (!result.success || !result.result?.data?.[0]) {
    throw new Error('Failed to generate embedding');
  }

  return result.result.data[0];
}

/**
 * Query Vectorize for similar content
 */
async function queryVectorize(embedding: number[]): Promise<VectorMatch[]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/vectorize/v2/indexes/${VECTORIZE_INDEX}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        vector: embedding,
        topK: 3,
        returnMetadata: 'all',
      }),
    }
  );

  const result = (await response.json()) as {
    success: boolean;
    result?: { matches: VectorMatch[] };
  };

  if (!result.success || !result.result?.matches) {
    console.warn('Vectorize query returned no matches');
    return [];
  }

  return result.result.matches;
}

/**
 * Build context from vector matches
 */
function buildContext(matches: VectorMatch[]): string {
  if (matches.length === 0) {
    return 'No relevant information found in knowledge base.';
  }

  return matches
    .map((m) => {
      if (!m.metadata) return '';
      const { category, question, answer } = m.metadata;

      let entry = '';
      if (category) entry += `[${category}] `;
      if (question) entry += `Q: ${question}\n`;
      if (answer) entry += `A: ${answer}`;
      return entry;
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Call Workers AI model
 */
async function callWorkersAI(modelId: string, prompt: string, context: string): Promise<string> {
  const systemPrompt = SYSTEM_PROMPT.replace('{context}', context);

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${modelId}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: 500,
        temperature: 0.7,
      }),
    }
  );

  const result = (await response.json()) as {
    success: boolean;
    result?: { response: string };
    errors?: unknown[];
  };

  if (!result.success || !result.result?.response) {
    throw new Error(`Workers AI error: ${JSON.stringify(result.errors)}`);
  }

  return result.result.response;
}

/**
 * Call Anthropic Claude API
 */
async function callAnthropic(modelId: string, prompt: string, context: string): Promise<string> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  const systemPrompt = SYSTEM_PROMPT.replace('{context}', context);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const result = (await response.json()) as {
    content?: Array<{ type: string; text: string }>;
    error?: { message: string };
  };

  if (result.error) {
    throw new Error(`Anthropic error: ${result.error.message}`);
  }

  const textContent = result.content?.find((c) => c.type === 'text');
  if (!textContent) {
    throw new Error('No text response from Anthropic');
  }

  return textContent.text;
}

/**
 * Call Google Gemini API
 */
async function callGemini(modelId: string, prompt: string, context: string): Promise<string> {
  if (!GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY not set');
  }

  const systemPrompt = SYSTEM_PROMPT.replace('{context}', context);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${GOOGLE_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 500,
          temperature: 0.7,
        },
      }),
    }
  );

  const result = (await response.json()) as {
    candidates?: Array<{
      content: { parts: Array<{ text: string }> };
    }>;
    error?: { message: string };
  };

  if (result.error) {
    throw new Error(`Gemini error: ${result.error.message}`);
  }

  const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(`No text response from Gemini: ${JSON.stringify(result)}`);
  }

  return text;
}

/**
 * Test all models with the same question and context
 */
async function testModels(question: string): Promise<TestResult[]> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Question: ${question}`);
  console.log(`${'='.repeat(70)}`);

  // Generate embedding and get context
  console.log('\nRetrieving context from Vectorize...');
  const embedding = await generateEmbedding(question);
  const matches = await queryVectorize(embedding);

  console.log(`Found ${matches.length} matches:`);
  matches.forEach((m, i) => {
    console.log(`  ${i + 1}. [${m.score.toFixed(3)}] ${m.metadata?.question?.slice(0, 60)}...`);
  });

  const context = buildContext(matches);
  console.log(`\nContext (${context.length} chars):`);
  console.log('-'.repeat(40));
  console.log(context.slice(0, 500) + (context.length > 500 ? '...' : ''));
  console.log('-'.repeat(40));

  const results: TestResult[] = [];

  // Test each model
  for (const model of MODELS) {
    console.log(`\nTesting ${model.name}...`);
    const startTime = Date.now();

    try {
      let response: string;

      switch (model.provider) {
        case 'workers-ai':
          if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
            throw new Error('Cloudflare credentials not set');
          }
          response = await callWorkersAI(model.modelId, question, context);
          break;

        case 'anthropic':
          response = await callAnthropic(model.modelId, question, context);
          break;

        case 'google':
          response = await callGemini(model.modelId, question, context);
          break;
      }

      const timeMs = Date.now() - startTime;

      results.push({
        model: model.name,
        response,
        timeMs,
        cost: model.costPerQuery,
      });

      console.log(`  ✓ ${timeMs}ms`);
    } catch (error) {
      const timeMs = Date.now() - startTime;
      results.push({
        model: model.name,
        response: '',
        timeMs,
        cost: model.costPerQuery,
        error: error instanceof Error ? error.message : String(error),
      });

      console.log(`  ✗ Error: ${error instanceof Error ? error.message : error}`);
    }
  }

  return results;
}

/**
 * Display results in a table format
 */
function displayResults(results: TestResult[]) {
  console.log(`\n${'='.repeat(70)}`);
  console.log('RESULTS');
  console.log(`${'='.repeat(70)}\n`);

  for (const result of results) {
    console.log(`┌${'─'.repeat(68)}┐`);
    console.log(
      `│ ${result.model.padEnd(50)} │ ${result.timeMs.toString().padStart(5)}ms │ ${result.cost.padStart(8)} │`
    );
    console.log(`├${'─'.repeat(68)}┤`);

    if (result.error) {
      console.log(`│ ERROR: ${result.error.slice(0, 60).padEnd(60)} │`);
    } else {
      // Word wrap the response
      const lines = wrapText(result.response, 66);
      for (const line of lines) {
        console.log(`│ ${line.padEnd(66)} │`);
      }
    }

    console.log(`└${'─'.repeat(68)}┘\n`);
  }
}

/**
 * Word wrap text to specified width
 */
function wrapText(text: string, width: number): string[] {
  const words = text.replace(/\n/g, ' ').split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= width) {
      currentLine += (currentLine ? ' ' : '') + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines;
}

// Conversation history for multi-turn chat
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}
let conversationHistory: ChatMessage[] = [];
let chatMode: ModelConfig | null = null;

/**
 * Interactive mode
 */
async function interactiveMode() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('\n=== AI Model Comparison Tool ===');
  console.log('Commands:');
  console.log('  <question>     Compare all models (no history)');
  console.log('  chat <n>       Start conversation with model #n');
  console.log('  /reset         Clear conversation history');
  console.log('  /exit          Exit chat mode, back to comparison');
  console.log('  quit           Exit the tool\n');

  const sampleQuestions = [
    'How do I reset my password?',
    'What are your pricing plans?',
    'I need help with my account',
    'How do I contact support?',
    'Can I get a refund?',
  ];

  console.log('Sample questions:');
  sampleQuestions.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
  console.log('\nModels:');
  MODELS.forEach((m, i) => console.log(`  ${i + 1}. ${m.name}`));
  console.log('');

  const askQuestion = () => {
    const prompt = chatMode ? `[${chatMode.name}] You: ` : 'Question (or number 1-5): ';

    rl.question(prompt, async (input) => {
      const trimmed = input.trim();

      if (trimmed.toLowerCase() === 'quit' || trimmed.toLowerCase() === 'q') {
        rl.close();
        return;
      }

      // Handle commands
      if (trimmed === '/reset') {
        conversationHistory = [];
        console.log('Conversation history cleared.\n');
        askQuestion();
        return;
      }

      if (trimmed === '/exit') {
        chatMode = null;
        conversationHistory = [];
        console.log('Exited chat mode. Now comparing all models.\n');
        askQuestion();
        return;
      }

      if (trimmed.startsWith('chat ')) {
        const modelNum = parseInt(trimmed.slice(5));
        if (modelNum >= 1 && modelNum <= MODELS.length) {
          chatMode = MODELS[modelNum - 1];
          conversationHistory = [];
          console.log(`\nEntering chat mode with ${chatMode.name}`);
          console.log('Type /exit to return to comparison mode, /reset to clear history.\n');
        } else {
          console.log(`Invalid model number. Use 1-${MODELS.length}.\n`);
        }
        askQuestion();
        return;
      }

      // Check if it's a number reference to sample questions
      const num = parseInt(trimmed);
      const question =
        num >= 1 && num <= sampleQuestions.length ? sampleQuestions[num - 1] : trimmed;

      if (!question) {
        askQuestion();
        return;
      }

      try {
        if (chatMode) {
          // Single model chat mode with history
          await testSingleModelWithHistory(chatMode, question);
        } else {
          // Compare all models (no history)
          const results = await testModels(question);
          displayResults(results);
        }
      } catch (error) {
        console.error('Error:', error);
      }

      askQuestion();
    });
  };

  askQuestion();
}

/**
 * Test a single model with conversation history
 */
async function testSingleModelWithHistory(model: ModelConfig, question: string) {
  console.log('\nRetrieving context...');
  const embedding = await generateEmbedding(question);
  const matches = await queryVectorize(embedding);
  const context = buildContext(matches);

  // Build prompt with conversation history
  let fullPrompt = '';
  if (conversationHistory.length > 0) {
    fullPrompt += 'Previous conversation:\n';
    for (const msg of conversationHistory) {
      fullPrompt += msg.role === 'user' ? `Customer: ${msg.content}\n` : `Assistant: ${msg.content}\n`;
    }
    fullPrompt += '\nCurrent customer message:\n';
  }
  fullPrompt += question;

  console.log(`Testing ${model.name}...`);
  const start = Date.now();

  let response: string;
  try {
    switch (model.provider) {
      case 'workers-ai':
        response = await callWorkersAI(model.modelId, fullPrompt, context);
        break;
      case 'anthropic':
        response = await callAnthropic(model.modelId, fullPrompt, context);
        break;
      case 'google':
        response = await callGemini(model.modelId, fullPrompt, context);
        break;
    }
  } catch (error) {
    console.error(`Error: ${error}`);
    return;
  }

  const elapsed = Date.now() - start;

  // Store in history
  conversationHistory.push({ role: 'user', content: question });
  conversationHistory.push({ role: 'assistant', content: response });

  // Display response
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`${model.name} (${elapsed}ms)`);
  console.log(`${'─'.repeat(70)}`);
  console.log(response);
  console.log(`${'─'.repeat(70)}\n`);
}

/**
 * Main
 */
async function main() {
  // Check required environment variables
  const missing: string[] = [];
  if (!CLOUDFLARE_ACCOUNT_ID) missing.push('CLOUDFLARE_ACCOUNT_ID');
  if (!CLOUDFLARE_API_TOKEN) missing.push('CLOUDFLARE_API_TOKEN');

  if (missing.length > 0) {
    console.error('Missing required environment variables:', missing.join(', '));
    console.log('\nOptional (for external models):');
    console.log('  ANTHROPIC_API_KEY - for Claude');
    console.log('  GOOGLE_API_KEY - for Gemini');
    process.exit(1);
  }

  // Check optional API keys
  if (!ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY not set - Claude tests will be skipped');
  }
  if (!GOOGLE_API_KEY) {
    console.warn('GOOGLE_API_KEY not set - Gemini tests will be skipped');
  }

  // Check for command line argument
  const question = process.argv[2];

  if (question) {
    // Single question mode
    const results = await testModels(question);
    displayResults(results);
  } else {
    // Interactive mode
    await interactiveMode();
  }
}

main().catch(console.error);
