import { describe, expect, it, vi } from 'vitest';
import { Embedder, MAX_INPUT_CHARS, type EmbedPipeline } from '../../src/worker/embedder.js';

/**
 * A stand-in for the real feature-extraction pipeline. Deterministic, and it
 * returns one shared buffer for the whole batch exactly as transformers.js
 * does — which is the detail that makes row copying necessary.
 */
function fakePipeline(dim = 4) {
  const calls: string[][] = [];

  const instance = (async (texts: string[]) => {
    calls.push([...texts]);
    const data = new Float32Array(texts.length * dim);
    texts.forEach((text, row) => {
      for (let d = 0; d < dim; d += 1) {
        data[row * dim + d] = (text.charCodeAt(d % Math.max(1, text.length)) || 1) / 128;
      }
    });
    return { dims: [texts.length, dim], data };
  }) as EmbedPipeline;

  return { instance, calls };
}

const load = (dim = 4) => {
  const fake = fakePipeline(dim);
  return Embedder.load({ createPipeline: async () => fake.instance }).then((embedder) => ({
    embedder,
    ...fake,
  }));
};

describe('Embedder', () => {
  it('reports an id identifying the vector space', async () => {
    const { instance } = fakePipeline();
    const embedder = await Embedder.load({
      modelId: 'Xenova/all-MiniLM-L6-v2',
      dtype: 'q8',
      createPipeline: async () => instance,
    });
    // This string goes into the cache key, so swapping model or precision must
    // change it.
    expect(embedder.id).toBe('Xenova/all-MiniLM-L6-v2@q8');
  });

  it('reads dimensionality from the model rather than assuming it', async () => {
    const { embedder } = await load(384);
    expect(embedder.dim).toBe(384);

    const { embedder: other } = await load(768);
    expect(other.dim).toBe(768);
  });

  it('returns one vector per input, in order', async () => {
    const { embedder } = await load();
    const vectors = await embedder.embed(['alpha', 'beta', 'gamma']);

    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0]).toHaveLength(4);
  });

  it('copies each row out of the shared batch buffer', async () => {
    const { embedder } = await load();
    const [first, second] = await embedder.embed(['alpha', 'beta']);

    // If rows were views onto one buffer, mutating one would corrupt the other.
    first![0] = 999;
    expect(second![0]).not.toBe(999);
  });

  it('batches, so a large index does not go through the model in one call', async () => {
    const { embedder, calls } = await load();
    await embedder.embed(['a', 'b', 'c', 'd', 'e'], { batchSize: 2 });

    expect(calls.map((batch) => batch.length)).toEqual([1, 2, 2, 1]);
    // The leading [1] is the dimension probe done at load time.
  });

  it('truncates over-long input rather than letting the tokenizer silently drop it', async () => {
    const { embedder, calls } = await load();
    await embedder.embed(['x'.repeat(MAX_INPUT_CHARS * 3)]);

    const sent = calls.at(-1)![0]!;
    expect(sent.length).toBe(MAX_INPUT_CHARS);
  });

  it('returns nothing for no input, without calling the model', async () => {
    const { embedder, calls } = await load();
    const before = calls.length;

    expect(await embedder.embed([])).toEqual([]);
    expect(calls.length).toBe(before);
  });

  it('embedOne returns a single vector', async () => {
    const { embedder } = await load();
    const vector = await embedder.embedOne('hello');
    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector).toHaveLength(4);
  });

  it('aborts between batches when signalled', async () => {
    const { embedder } = await load();
    const controller = new AbortController();
    controller.abort();

    // A cancel arriving mid-index has to be honoured, not swallowed.
    await expect(embedder.embed(['a', 'b'], { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('disposes the underlying pipeline', async () => {
    const dispose = vi.fn();
    const { instance } = fakePipeline();
    (instance as EmbedPipeline).dispose = dispose;

    const embedder = await Embedder.load({ createPipeline: async () => instance });
    await embedder.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('reports load progress when a callback is given', async () => {
    const onProgress = vi.fn();
    const { instance } = fakePipeline();

    await Embedder.load({
      onProgress,
      createPipeline: async (options) => {
        options.onProgress?.({ name: 'model.onnx', loaded: 512, total: 1024 });
        return instance;
      },
    });

    expect(onProgress).toHaveBeenCalledWith({ name: 'model.onnx', loaded: 512, total: 1024 });
  });
});
