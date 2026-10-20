import { describe, expect, it } from 'vitest';
import { generateBotResponse } from '../src/bot';
import { LOW_CONFIDENCE_RESPONSE } from '../src/prompts';
import type { ChatMessage, Env } from '../src/types';

const visitor = (content: string): ChatMessage => ({ id: crypto.randomUUID(), role: 'customer', content, timestamp: 0 });

/** An env with fake Workers AI and Vectorize bindings that records what the bot sends. */
function fakeEnv(options: { score: number; reply?: unknown; fail?: boolean }) {
  const runs: Array<{ model: string; input: Record<string, unknown> }> = [];
  const env = {
    AI: {
      run: async (model: string, input: Record<string, unknown>) => {
        runs.push({ model, input });
        if (options.fail) throw new Error('model unavailable');
        if ('text' in input) return { shape: [1, 1024], data: [new Array(1024).fill(0.1)] };
        return options.reply;
      },
    },
    SUPPORT_INDEX: {
      query: async () => ({
        count: 1,
        matches: [
          {
            id: 'faq-1',
            score: options.score,
            metadata: { category: 'Shipping', question: 'How long does shipping take?', answer: 'Two to three days.' },
          },
        ],
      }),
    },
  } as unknown as Env;
  return { env, runs };
}

describe('generateBotResponse', () => {
  it('answers from the knowledge base with thinking switched off', async () => {
    const { env, runs } = fakeEnv({
      score: 0.8,
      reply: { choices: [{ message: { content: 'Shipping takes two to three days.' } }] },
    });
    const response = await generateBotResponse(env, [visitor('How long does shipping take?')]);

    expect(response).toMatchObject({ content: 'Shipping takes two to three days.', needsHandoff: false });
    const chat = runs.find((run) => 'messages' in run.input)!;
    expect(chat.input.chat_template_kwargs).toEqual({ enable_thinking: false });
    const [system, user] = chat.input.messages as Array<{ role: string; content: string }>;
    expect(system.content).toContain('A: Two to three days.');
    expect(user).toEqual({ role: 'user', content: 'How long does shipping take?' });
  });

  it('still understands models that answer with `response`', async () => {
    const { env } = fakeEnv({ score: 0.8, reply: { response: 'Two to three days.' } });
    expect((await generateBotResponse(env, [visitor('Shipping time?')])).content).toBe('Two to three days.');
  });

  it('hands over when nothing in the knowledge base matches well', async () => {
    const { env, runs } = fakeEnv({ score: 0.2 });
    const response = await generateBotResponse(env, [visitor('Do you sell spaceships?')]);
    expect(response).toMatchObject({ content: LOW_CONFIDENCE_RESPONSE, needsHandoff: true, handoffReason: 'low_confidence' });
    expect(runs.some((run) => 'messages' in run.input)).toBe(false);
  });

  it('hands billing questions to a human without asking the model', async () => {
    const { env, runs } = fakeEnv({ score: 0.9 });
    const response = await generateBotResponse(env, [visitor('I want a refund for my last invoice')]);
    expect(response).toMatchObject({ needsHandoff: true, handoffReason: 'billing' });
    expect(runs).toHaveLength(0);
  });

  it('hands over instead of passing on contact details the knowledge base does not contain', async () => {
    const { env } = fakeEnv({
      score: 0.8,
      reply: { choices: [{ message: { content: 'Call our free hotline 0800 123 9655.' } }] },
    });
    expect(await generateBotResponse(env, [visitor('How long does shipping take?')])).toMatchObject({
      needsHandoff: true,
      handoffReason: 'unverified_details',
    });
  });

  it('stops asking the model after the per-chat limit', async () => {
    const { env, runs } = fakeEnv({ score: 0.9, reply: { response: 'Two days.' } });
    expect(await generateBotResponse(env, [visitor('Shipping?')], 20)).toMatchObject({
      needsHandoff: true,
      handoffReason: 'reply_limit',
    });
    expect(runs).toHaveLength(0);
  });

  it('hands over instead of failing when the model errors or returns nothing', async () => {
    expect(await generateBotResponse(fakeEnv({ score: 0.9, fail: true }).env, [visitor('Hello?')])).toMatchObject({
      needsHandoff: true,
      handoffReason: 'error',
    });
    const empty = fakeEnv({ score: 0.9, reply: { choices: [{ message: { content: '<think>hmm</think>' } }] } });
    expect(await generateBotResponse(empty.env, [visitor('Hello?')])).toMatchObject({
      needsHandoff: true,
      handoffReason: 'empty_reply',
    });
  });
});
