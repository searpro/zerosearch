import { type Tier, minTier } from '../types.js';

/**
 * Device probing and tier selection.
 *
 * The load-bearing signal is the WebGPU adapter's own reported limits. The
 * convenient alternatives — `navigator.deviceMemory` and `navigator.connection`
 * — are Chromium-only, so treating either as a gate would silently push every
 * Safari and Firefox visitor into the wrong tier. They are used as hints that
 * can only ever downgrade, never as a requirement.
 */

// WebGPU is not in TypeScript's standard lib yet, and pulling @webgpu/types in
// for three fields is not worth the dependency.
interface GpuLimits {
  maxBufferSize?: number;
  maxStorageBufferBindingSize?: number;
}
interface GpuAdapter {
  limits?: GpuLimits;
}
interface Gpu {
  requestAdapter(options?: { powerPreference?: string }): Promise<GpuAdapter | null>;
}
interface ProbeNavigator {
  gpu?: Gpu;
  deviceMemory?: number;
  connection?: { saveData?: boolean; effectiveType?: string };
  hardwareConcurrency?: number;
}

export interface Capabilities {
  webgpu: boolean;
  maxBufferSize: number | null;
  maxStorageBufferBindingSize: number | null;
  /** Chromium-only. Null elsewhere, which must never be read as "low". */
  deviceMemoryGb: number | null;
  saveData: boolean;
  effectiveType: string | null;
  cores: number | null;
}

const MB = 1024 * 1024;

/** Enough headroom for a ~300MB quantised model plus its activations. */
const SMALL_TIER_BUFFER = 256 * MB;
const SMALL_TIER_BINDING = 128 * MB;
/** Enough for the larger generator, which is roughly 450MB. */
const STANDARD_TIER_BUFFER = 1024 * MB;

export async function probe(nav: ProbeNavigator = navigator as ProbeNavigator): Promise<Capabilities> {
  const base: Capabilities = {
    webgpu: false,
    maxBufferSize: null,
    maxStorageBufferBindingSize: null,
    deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    saveData: nav.connection?.saveData === true,
    effectiveType: nav.connection?.effectiveType ?? null,
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
  };

  if (!nav.gpu) return base;

  try {
    const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return base;
    return {
      ...base,
      webgpu: true,
      maxBufferSize: adapter.limits?.maxBufferSize ?? null,
      maxStorageBufferBindingSize: adapter.limits?.maxStorageBufferBindingSize ?? null,
    };
  } catch {
    // requestAdapter can reject outright on a blocklisted driver.
    return base;
  }
}

export interface TierDecision {
  tier: Tier;
  reason: string;
  /** True when the device could have gone higher but the site's ceiling said no. */
  capped: boolean;
}

/**
 * Pick the tier this device should run at, never exceeding the site's ceiling.
 *
 * Everything here degrades toward `retrieval`, which works everywhere and costs
 * about 36MB. A wrong guess in that direction costs answer quality; a wrong
 * guess in the other direction costs a visitor a 300MB download their device
 * cannot actually run.
 */
export function selectTier(caps: Capabilities, ceiling: Tier): TierDecision {
  const decision = decide(caps);
  const tier = minTier(decision.tier, ceiling);
  return { tier, reason: decision.reason, capped: tier !== decision.tier };
}

function decide(caps: Capabilities): { tier: Tier; reason: string } {
  if (!caps.webgpu) {
    return { tier: 'retrieval', reason: 'no WebGPU: generation would run at a few tokens per second' };
  }
  if (caps.saveData) {
    return { tier: 'retrieval', reason: 'client asked to save data' };
  }
  if (caps.effectiveType === 'slow-2g' || caps.effectiveType === '2g') {
    return { tier: 'retrieval', reason: `connection reported as ${caps.effectiveType}` };
  }

  const buffer = caps.maxBufferSize;
  const binding = caps.maxStorageBufferBindingSize;
  // Unknown limits are not treated as small: some adapters simply do not report
  // them, and refusing on absence would exclude working devices.
  const bufferOk = buffer === null || buffer >= SMALL_TIER_BUFFER;
  const bindingOk = binding === null || binding >= SMALL_TIER_BINDING;

  if (!bufferOk || !bindingOk) {
    return { tier: 'retrieval', reason: 'WebGPU adapter limits are too small for a generative model' };
  }

  // deviceMemory only ever downgrades: absent on Safari, so it cannot be required.
  const lowMemory = caps.deviceMemoryGb !== null && caps.deviceMemoryGb < 8;
  if (buffer !== null && buffer >= STANDARD_TIER_BUFFER && !lowMemory) {
    return { tier: 'standard', reason: 'WebGPU with generous adapter limits' };
  }
  return { tier: 'small', reason: 'WebGPU available' };
}
