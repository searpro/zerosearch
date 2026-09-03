import { configureModelHost, loadLibrary, progressAdapter } from './library.js';

/**
 * Text embedding, via transformers.js.
 *
 * all-MiniLM-L6-v2 at q8 is about 23MB and 384 dimensions — small enough that
 * the retrieval tier stays around 36MB all-in including the ONNX runtime, which
 * is what lets the widget stay useful on a device with no WebGPU at all.
 *
 * The model is reached through an interface rather than called directly so a
 * multilingual model can be swapped in by configuration, and so tests can run
 * without downloading anything.
 */

export const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const DEFAULT_DTYPE = 'q8';
export const DEFAULT_DIM = 384;



/** Model max sequence length is 256 word-piece tokens; longer input is truncated. */
export const MAX_INPUT_CHARS = 2000;

export interface EmbedTensor {
  dims: number[];
  data: ArrayLike<number>;
}

export interface EmbedPipeline {
  (texts: string[], options: { pooling: 'mean'; normalize: boolean }): Promise<EmbedTensor>;
  dispose?: () => Promise<void> | void;
}

export interface ModelProgress {
  name: string;
  loaded: number;
  total: number;
}

export interface EmbedderOptions {
  modelId?: string;
  dtype?: string;
  device?: 'wasm' | 'webgpu' | 'auto';
  /** Self-hosted weights. Null uses the transformers.js default (the HF CDN). */
  modelBaseUrl?: string | null;
  /** Where to load the transformers.js module itself from. */
  libraryUrl?: string | null;
  onProgress?: (progress: ModelProgress) => void;
  /** Injection point for tests, so no test ever downloads a model. */
  createPipeline?: (options: EmbedderOptions) => Promise<EmbedPipeline>;
}

export class Embedder {
  /** Identifies the vector space. Part of the cache key — see `buildCacheKey`. */
  readonly id: string;
  readonly dim: number;
  #pipeline: EmbedPipeline;

  private constructor(id: string, dim: number, instance: EmbedPipeline) {
    this.id = id;
    this.dim = dim;
    this.#pipeline = instance;
  }

  static async load(options: EmbedderOptions = {}): Promise<Embedder> {
    const modelId = options.modelId ?? DEFAULT_MODEL_ID;
    const dtype = options.dtype ?? DEFAULT_DTYPE;

    const create = options.createPipeline ?? defaultPipeline;
    const instance = await create({ ...options, modelId, dtype });

    // Read the real dimensionality rather than trusting a constant, so swapping
    // in a different model cannot silently produce mis-shaped vectors.
    const probe = await instance(['dimension probe'], { pooling: 'mean', normalize: true });
    const dim = probe.dims[probe.dims.length - 1] ?? DEFAULT_DIM;

    return new Embedder(`${modelId}@${dtype}`, dim, instance);
  }

  /**
   * Embed a batch. Batches are yielded between so the worker stays responsive
   * to messages — a cancel request arriving mid-index has to be heard.
   */
  async embed(
    texts: string[],
    { batchSize = 16, signal }: { batchSize?: number; signal?: AbortSignal } = {},
  ): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const out: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      if (signal?.aborted) throw new DOMException('embedding aborted', 'AbortError');

      const batch = texts.slice(start, start + batchSize).map(truncate);
      const tensor = await this.#pipeline(batch, { pooling: 'mean', normalize: true });
      const dim = tensor.dims[tensor.dims.length - 1] ?? this.dim;

      for (let row = 0; row < batch.length; row += 1) {
        // Copy: the tensor hands back one shared buffer for the whole batch.
        const vector = new Float32Array(dim);
        for (let d = 0; d < dim; d += 1) vector[d] = tensor.data[row * dim + d] ?? 0;
        out.push(vector);
      }

      if (start + batchSize < texts.length) await yieldToEventLoop();
    }
    return out;
  }

  async embedOne(text: string): Promise<Float32Array> {
    const [vector] = await this.embed([text]);
    if (!vector) throw new Error('embedder returned nothing');
    return vector;
  }

  async dispose(): Promise<void> {
    await this.#pipeline.dispose?.();
  }
}

function truncate(text: string): string {
  return text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function defaultPipeline(options: EmbedderOptions): Promise<EmbedPipeline> {
  const { env, pipeline } = await loadLibrary(options.libraryUrl ?? undefined);
  configureModelHost(env, options.modelBaseUrl);

  const instance = await pipeline('feature-extraction', options.modelId ?? DEFAULT_MODEL_ID, {
    dtype: options.dtype ?? DEFAULT_DTYPE,
    device: options.device ?? 'auto',
    progress_callback: progressAdapter(options.onProgress),
  });

  return instance as unknown as EmbedPipeline;
}
