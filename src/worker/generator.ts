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
  /**
   * Extra arguments for the model's chat template.
   *
   * The pipeline spreads `tokenizer_kwargs` into its `apply_chat_template`
   * call, which is how a reasoning model is told not to reason: Qwen3 emits a
   * `<think>` block by default, and with a 220-token budget it would spend the
   * whole allowance thinking and return nothing.
   */
  templateOptions?: Record<string, unknown>;
}

/**
 * The model each tier loads.
 *
 * Both tiers currently load the same model, because it is the only one measured
 * to work. Scored on the golden set in `eval/queries.json`, warm index:
 *
 *   SmolLM2-360M  q4      8/11   <- shipped
 *   SmolLM2-360M  q4f16   empty assistant turn, every time, no error
 *   Qwen3-0.6B    q4      fails to allocate a session (std::bad_alloc)
 *   Qwen3-0.6B    q4f16   1/11, echoes the prompt's worked example back
 *
 * Two things worth keeping in mind before changing this. `q4f16` is broken for
 * both models on this stack — silently, which is the expensive kind. And the
 * larger model was worse, not better: at 0.6B it neither fits at q4 nor follows
 * the prompt at q4f16, so "use a bigger model" is not an available fix here.
 *
 * The tier still does real work: it decides whether generation is offered at
 * all. `standard` exists so a validated larger model can be dropped in without
 * touching anything else.
 */
const SMOLLM2: Omit<GeneratorModel, 'label'> = {
  id: 'onnx-community/SmolLM2-360M-Instruct-ONNX',
  dtype: 'q4',
  approxBytes: 386 * 1024 * 1024,
};

export const GENERATOR_MODELS: Record<Exclude<Tier, 'retrieval'>, GeneratorModel> = {
  small: { ...SMOLLM2, label: 'SmolLM2 360M' },
  standard: { ...SMOLLM2, label: 'SmolLM2 360M' },
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
      ...(this.model.templateOptions ? { tokenizer_kwargs: this.model.templateOptions } : {}),
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
