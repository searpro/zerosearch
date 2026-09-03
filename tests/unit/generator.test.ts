import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/chat/prompt.js';
import { GENERATOR_MODELS, Generator, type GeneratePipeline, modelForTier } from '../../src/worker/generator.js';

const MODEL = GENERATOR_MODELS.small;

function fakePipeline(reply: string | ChatMessage[] = 'The Team plan costs $49 [1].') {
  const calls: { messages: ChatMessage[]; options: Record<string, unknown> }[] = [];

  const instance = (async (messages: ChatMessage[], options: Record<string, unknown>) => {
    calls.push({ messages, options });
    return [{ generated_text: reply }];
  }) as GeneratePipeline;
  instance.tokenizer = { fake: true };

  return { instance, calls };
}

const load = (reply?: string | ChatMessage[]) => {
  const fake = fakePipeline(reply);
  return Generator.load({
    model: MODEL,
    createPipeline: async () => fake.instance,
    createStreamer: async () => ({ streamer: true }),
  }).then((generator) => ({ generator, ...fake }));
};

const ask: ChatMessage[] = [
  { role: 'system', content: 'rules' },
  { role: 'user', content: 'Sources: ...\n\nQuestion: how much?' },
];

describe('modelForTier', () => {
  it('has no model for the retrieval tier', () => {
    expect(modelForTier('retrieval')).toBeNull();
  });

  it('maps each generative tier to a model with a stated size', () => {
    for (const tier of ['small', 'standard'] as const) {
      const model = modelForTier(tier)!;
      expect(model.id).toContain('/');
      // Not q4f16, despite being smaller: the f16 build of SmolLM2-360M
      // generated an empty assistant turn every time on this stack — no
      // tokens, no error, indistinguishable from a refusal.
      expect(model.dtype).toBe('q4');
      // The size is shown to the visitor before they commit to the download.
      expect(model.approxBytes).toBeGreaterThan(100 * 1024 * 1024);
      expect(model.label.length).toBeGreaterThan(0);
    }
  });

  it('uses only the configuration measured to work', () => {
    // Qwen3-0.6B could not allocate a session at q4 and echoed the prompt back
    // at q4f16, so both tiers load the model that scored 8/11. See the note in
    // generator.ts before changing this.
    expect(GENERATOR_MODELS.standard.id).toBe(GENERATOR_MODELS.small.id);
    expect(GENERATOR_MODELS.small.dtype).toBe('q4');
  });
});

describe('Generator', () => {
  it('passes the chat through and returns the generated text', async () => {
    const { generator, calls } = await load();
    const text = await generator.generate(ask);

    expect(text).toBe('The Team plan costs $49 [1].');
    expect(calls[0]!.messages).toEqual(ask);
  });

  it('decodes greedily, because faithfulness matters more than variety here', async () => {
    const { generator, calls } = await load();
    await generator.generate(ask);

    expect(calls[0]!.options['do_sample']).toBe(false);
    // Without this the prompt comes back as part of the answer.
    expect(calls[0]!.options['return_full_text']).toBe(false);
    expect(calls[0]!.options['max_new_tokens']).toBeGreaterThan(0);
  });

  it('honours a max token override', async () => {
    const { generator, calls } = await load();
    await generator.generate(ask, { maxNewTokens: 42 });
    expect(calls[0]!.options['max_new_tokens']).toBe(42);
  });

  it('attaches a streamer only when someone is listening', async () => {
    const { generator, calls } = await load();

    await generator.generate(ask);
    expect(calls[0]!.options['streamer']).toBeUndefined();

    await generator.generate(ask, { onToken: () => {} });
    expect(calls[1]!.options['streamer']).toEqual({ streamer: true });
  });

  it('awaits the streamer instead of passing a promise through', async () => {
    // Building the streamer needs the library, so it is async. Handing the
    // pipeline a thenable would stream nothing, silently.
    const fake = fakePipeline();
    const generator = await Generator.load({
      model: MODEL,
      createPipeline: async () => fake.instance,
      createStreamer: async () => ({ real: 'streamer' }),
    });

    await generator.generate(ask, { onToken: () => {} });
    const streamer = fake.calls[0]!.options['streamer'];
    expect(streamer).toEqual({ real: 'streamer' });
    expect(streamer).not.toBeInstanceOf(Promise);
  });

  it('reads the answer out of a chat-shaped response', async () => {
    const { generator } = await load([
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'The answer is $49.' },
    ]);
    expect(await generator.generate(ask)).toBe('The answer is $49.');
  });

  it('returns empty rather than throwing on an unexpected response shape', async () => {
    const { generator } = await load([{ role: 'user', content: 'no assistant turn' }]);
    expect(await generator.generate(ask)).toBe('');
  });

  it('skips the streamer when the pipeline exposes no tokenizer', async () => {
    const instance = (async () => [{ generated_text: 'ok' }]) as GeneratePipeline;
    const generator = await Generator.load({ model: MODEL, createPipeline: async () => instance });

    // Must not throw just because streaming is unavailable.
    expect(await generator.generate(ask, { onToken: () => {} })).toBe('ok');
  });

  it('disposes the underlying pipeline', async () => {
    const dispose = vi.fn();
    const { instance } = fakePipeline();
    instance.dispose = dispose;

    const generator = await Generator.load({ model: MODEL, createPipeline: async () => instance });
    await generator.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
