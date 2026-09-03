/**
 * Loading transformers.js itself.
 *
 * The library is fetched at runtime rather than bundled. Bundling it drags in
 * the ONNX runtime's `.wasm` binaries, and Vite's library mode has no chunks to
 * put them in, so it base64-inlines them straight into the output — a 63MB
 * worker for a 2MB library. Loaded at runtime, the runtime fetches its wasm
 * normally, only when it is actually needed.
 */

/**
 * The `+esm` endpoint matters: the raw `dist/` file ships bare specifiers like
 * `onnxruntime-web/webgpu`, which a browser cannot resolve without an import
 * map. `+esm` rewrites them to absolute URLs.
 *
 * Pinned to an exact version, because an unpinned CDN specifier lets a
 * dependency change under a site that has not redeployed. Override with
 * `data-library-url` when a Content-Security-Policy forbids this origin.
 */
export const DEFAULT_LIBRARY_URL =
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm';

export interface TransformersEnv {
  allowLocalModels: boolean;
  remoteHost: string;
  remotePathTemplate: string;
}

export interface TransformersModule {
  env: TransformersEnv;
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>;
  TextStreamer: new (tokenizer: unknown, options: Record<string, unknown>) => unknown;
  ModelRegistry: {
    is_cached: (modelId: string, options?: Record<string, unknown>) => Promise<boolean>;
  };
}

let cached: Promise<TransformersModule> | null = null;

/** Load transformers.js once per worker, whatever asks for it first. */
export async function loadLibrary(url: string = DEFAULT_LIBRARY_URL): Promise<TransformersModule> {
  cached ??= (async () => {
    try {
      // @vite-ignore keeps the bundler from trying to resolve and inline this.
      return (await import(/* @vite-ignore */ url)) as TransformersModule;
    } catch (error) {
      // Let a later attempt retry rather than caching the failure forever.
      cached = null;
      throw new Error(
        `could not load transformers.js from ${url}. ` +
          'If this site sets a Content-Security-Policy, it must allow this origin in script-src, ' +
          'or set data-library-url to a copy you host yourself. ' +
          `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
  return await cached;
}

/** Point the library at self-hosted weights, when a site provides them. */
export function configureModelHost(env: TransformersEnv, modelBaseUrl: string | null | undefined): void {
  // In a browser there is no local model directory to fall back on, and leaving
  // this enabled produces a confusing 404 before the remote fetch is tried.
  env.allowLocalModels = false;
  if (!modelBaseUrl) return;

  // Weights laid out as <base>/<model id>/<files>. Sites behind a strict CSP
  // need this, since the HF CDN is usually not allowlisted.
  env.remoteHost = modelBaseUrl.endsWith('/') ? modelBaseUrl : `${modelBaseUrl}/`;
  env.remotePathTemplate = '{model}/';
}

/** Normalise the library's progress reports into something we can show. */
export function progressAdapter(
  onProgress: ((progress: { name: string; loaded: number; total: number }) => void) | undefined,
): ((report: unknown) => void) | undefined {
  if (!onProgress) return undefined;
  return (report: unknown) => {
    const p = report as { status?: string; file?: string; loaded?: number; total?: number };
    if (p.status !== 'progress') return;
    onProgress({ name: p.file ?? 'model', loaded: p.loaded ?? 0, total: p.total ?? 0 });
  };
}
