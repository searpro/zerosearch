import {
  HOST,
  WORKER,
  type AskParams,
  type HostFetchParams,
  type HostFetchResult,
  type HostManifestResult,
  type InitParams,
} from '../engine/protocol.js';
import { RpcPeer, type Transport } from '../engine/rpc.js';
import { Engine } from './engine.js';

/**
 * Worker entry: RPC wiring only.
 *
 * All the behaviour lives in `Engine`, which is written against injected
 * dependencies so it can be tested without a Worker, a network or a model
 * download. This file exists to connect that engine to the message port and to
 * the main thread's DOM services — page fetching, extraction and sitemap
 * parsing, none of which a worker can do for itself.
 */

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const peer = new RpcPeer(ctx as unknown as Transport);

let engine: Engine | null = null;

function require(): Engine {
  if (!engine) throw new Error('engine is not initialised; call init first');
  return engine;
}

peer.handle(WORKER.init, async (params: InitParams) => {
  const created = await Engine.init(params, {
    // The callbacks that need a DOM, answered on the main thread.
    fetchPage: (fetchParams: HostFetchParams) => peer.call<HostFetchResult>(HOST.fetchPage, fetchParams),
    manifest: () => peer.call<HostManifestResult>(HOST.manifest),
    notify: (type, payload) => peer.notify(type, payload),
  });
  engine = created.engine;
  return created.result;
});

peer.handle(WORKER.ensureManifest, () => require().ensureManifest());
peer.handle(WORKER.ask, (params: AskParams) => require().ask(params));
peer.handle(WORKER.enableGeneration, () => require().enableGeneration());
peer.handle(WORKER.generationStatus, () => require().generationStatus());
peer.handle(WORKER.revalidate, () => require().revalidate());
peer.handle(WORKER.stats, () => require().stats());

ctx.postMessage({ w: 'evt', t: 'worker:ready', p: null });
