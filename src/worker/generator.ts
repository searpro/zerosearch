import type { ChatMessage } from '../chat/prompt.js';
import type { Tier } from '../types.js';
import { configureModelHost, loadLibrary, progressAdapter } from './library.js';
import type { ModelProgress } from './embedder.js';

/**
 * Text generation, via transformers.js.
 *
 * Only ever reached on a device that passed the WebGPU probe. On WASM a 360M
 * model produces a few tokens per second, which is not a chat experience, so
 * those devices stay on retrieval-only answers rather than getting a slow
 * version of this.
 */

export interface GeneratorModel {
  id: string;
  dtype: string;
  /** Rough download size, shown to the visitor before they commit to it. */
  approxBytes: number;
  label: string;
}

/**
 * One model per tier. Both are instruction-tuned and small enough to load in a
 * browser; neither is good at reasoning, which is why the prompt asks only for
 * extraction and attribution rather than analysis.
 *
 * `q4`, not `q4f16`, despite `q4f16` being ~110MB smaller. Measured on this
 * stack, the f16 build of SmolLM2-360M generated an empty assistant turn every
 * time — no tokens, no error — which is the worst possible failure mode
 * because it looks exactly like a refusal. The f32-accumulation build works.
 */
export const GENERATOR_MODELS: Record<Exclude<Tier, 'retrieval'>, GeneratorModel> = {
  small: {
    id: 'onnx-community/SmolLM2-360M-Instruct-ONNX',
    dtype: 'q4',
    approxBytes: 386 * 1024 * 1024,
    label: 'SmolLM2 360M',
  },
  standard: {
    id: 'onnx-community/Qwen3-0.6B-ONNX',
    dtype: 'q4',
    approxBytes: 450 * 1024 * 1024,
    label: 'Qwen3 0.6B',
  },
};

export function modelForTier(tier: Tier): GeneratorModel | null {
  return tier === 'retrieval' ? null : GENERATOR_MODELS[tier];
}

export interface GeneratePipeline {
  (
    messages: ChatMessage[],
    options: Record<string, unknown>,
  ): Promise<{ generated_text: string | ChatMessage[] }[]>;
  tokenizer?: unknown;
  dispose?: () => Promise<void> | void;
}

export interface GeneratorOptions {
  model: GeneratorModel;
  modelBaseUrl?: string | null;
  libraryUrl?: string | null;
  onProgress?: (progress: ModelProgress) => void;
  /** Injection point for tests, so no test ever downloads a model. */
  createPipeline?: (options: GeneratorOptions) => Promise<GeneratePipeline>;
  /** Injection point for tests. */
  createStreamer?: (tokenizer: unknown, onToken: (text: string) => void) => Promise<unknown>;
}

export interface GenerateOptions {
  onToken?: (text: string) => void;
  maxNewTokens?: number;
}

export class Generator {
  readonly model: GeneratorModel;
  #pipeline: GeneratePipeline;
  #createStreamer: NonNullable<GeneratorOptions['createStreamer']>;

  private constructor(
    model: GeneratorModel,
    instance: GeneratePipeline,
    createStreamer: NonNullable<GeneratorOptions['createStreamer']>,
  ) {
    this.model = model;
    this.#pipeline = instance;
    this.#createStreamer = createStreamer;
  }

  /**
   * Whether the weights are already in the browser's cache.
   *
   * This is what lets the widget say "ready" instead of asking a returning
   * visitor to approve a download they already made.
   */
  static async isCached(model: GeneratorModel, libraryUrl?: string | null): Promise<boolean> {
    try {
      const { ModelRegistry } = await loadLibrary(libraryUrl ?? undefined);
      return await ModelRegistry.is_cached(model.id, { dtype: model.dtype, device: 'webgpu' });
    } catch {
      // Not knowing is not the same as not cached, but treating it as "not
      // cached" only costs an extra confirmation, which is the safe direction.
      return false;
    }
  }

  static async load(options: GeneratorOptions): Promise<Generator> {
    const create = options.createPipeline ?? defaultPipeline;
    const instance = await create(options);
    const createStreamer = options.createStreamer ?? defaultStreamer;
    return new Generator(options.model, instance, createStreamer);
  }

  /**
   * Generate an answer, streaming tokens as they arrive.
   *
   * Greedy decoding, not sampling. For grounded question answering, sampling
   * buys variety nobody asked for and costs faithfulness to the sources — the
   * one thing this has to get right.
   */
  async generate(messages: ChatMessage[], { onToken, maxNewTokens = 220 }: GenerateOptions = {}): Promise<string> {
    // Awaited: constructing the streamer needs the library, so it is async.
    // Passing the promise through would hand the pipeline a Thenable and
    // silently stream nothing — `streamer` is typed loosely enough that
    // neither TypeScript nor the library would complain.
    const streamer =
      onToken && this.#pipeline.tokenizer
        ? await this.#createStreamer(this.#pipeline.tokenizer, onToken)
        : undefined;

    const output = await this.#pipeline(messages, {
      max_new_tokens: maxNewTokens,
      do_sample: false,
      return_full_text: false,
      ...(streamer ? { streamer } : {}),
    });

    return readGenerated(output);
  }

  async dispose(): Promise<void> {
    await this.#pipeline.dispose?.();
  }
}

/**
 * The pipeline returns either a string or a chat array depending on how it was
 * called. With messages in, the last assistant turn is the answer.
 */
function readGenerated(output: { generated_text: string | ChatMessage[] }[]): string {
  const first = output[0]?.generated_text;
  if (typeof first === 'string') return first;
  if (Array.isArray(first)) {
    for (let i = first.length - 1; i >= 0; i -= 1) {
      const message = first[i];
      if (message?.role === 'assistant') return message.content;
    }
  }
  return '';
}

async function defaultPipeline(options: GeneratorOptions): Promise<GeneratePipeline> {
  const { env, pipeline } = await loadLibrary(options.libraryUrl ?? undefined);
  configureModelHost(env, options.modelBaseUrl);

  const instance = await pipeline('text-generation', options.model.id, {
    dtype: options.model.dtype,
    // Never 'auto' here. Falling back to WASM would produce a few tokens per
    // second after a 272MB download, which is worse than not offering it.
    device: 'webgpu',
    progress_callback: progressAdapter(options.onProgress),
  });

  return instance as unknown as GeneratePipeline;
}

async function defaultStreamer(tokenizer: unknown, onToken: (text: string) => void): Promise<unknown> {
  const { TextStreamer } = await loadLibrary();
  return new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: onToken,
  });
}
