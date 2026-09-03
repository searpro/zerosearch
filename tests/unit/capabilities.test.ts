import { describe, expect, it, vi } from 'vitest';
import { type Capabilities, probe, selectTier } from '../../src/worker/capabilities.js';

const MB = 1024 * 1024;

const caps = (overrides: Partial<Capabilities> = {}): Capabilities => ({
  webgpu: true,
  maxBufferSize: 2048 * MB,
  maxStorageBufferBindingSize: 512 * MB,
  deviceMemoryGb: 16,
  saveData: false,
  effectiveType: '4g',
  cores: 8,
  ...overrides,
});

describe('probe', () => {
  it('reports no WebGPU when navigator.gpu is absent', async () => {
    const result = await probe({ hardwareConcurrency: 4 });
    expect(result.webgpu).toBe(false);
    expect(result.maxBufferSize).toBeNull();
    expect(result.cores).toBe(4);
  });

  it('reads adapter limits when WebGPU is available', async () => {
    const result = await probe({
      gpu: {
        requestAdapter: async () => ({ limits: { maxBufferSize: 1024 * MB, maxStorageBufferBindingSize: 256 * MB } }),
      },
    });
    expect(result.webgpu).toBe(true);
    expect(result.maxBufferSize).toBe(1024 * MB);
  });

  it('treats a null adapter as no WebGPU', async () => {
    const result = await probe({ gpu: { requestAdapter: async () => null } });
    expect(result.webgpu).toBe(false);
  });

  it('survives requestAdapter rejecting, as it does on a blocklisted driver', async () => {
    const result = await probe({
      gpu: {
        requestAdapter: async () => {
          throw new Error('adapter unavailable');
        },
      },
    });
    expect(result.webgpu).toBe(false);
  });

  it('leaves Chromium-only hints null rather than guessing', async () => {
    // This is the Safari shape: no deviceMemory, no connection.
    const result = await probe({ gpu: { requestAdapter: async () => ({ limits: {} }) } });
    expect(result.deviceMemoryGb).toBeNull();
    expect(result.effectiveType).toBeNull();
    expect(result.saveData).toBe(false);
  });
});

describe('selectTier', () => {
  it('drops to retrieval without WebGPU', () => {
    const decision = selectTier(caps({ webgpu: false }), 'standard');
    expect(decision.tier).toBe('retrieval');
    expect(decision.reason).toMatch(/WebGPU/);
  });

  it('drops to retrieval when the client asked to save data', () => {
    expect(selectTier(caps({ saveData: true }), 'standard').tier).toBe('retrieval');
  });

  it('drops to retrieval on a 2g connection', () => {
    expect(selectTier(caps({ effectiveType: '2g' }), 'standard').tier).toBe('retrieval');
    expect(selectTier(caps({ effectiveType: 'slow-2g' }), 'standard').tier).toBe('retrieval');
  });

  it('drops to retrieval when adapter limits are too small for a generative model', () => {
    const decision = selectTier(caps({ maxBufferSize: 64 * MB }), 'standard');
    expect(decision.tier).toBe('retrieval');
    expect(decision.reason).toMatch(/adapter limits/);
  });

  it('reaches standard on a capable device', () => {
    expect(selectTier(caps(), 'standard').tier).toBe('standard');
  });

  it('never exceeds the site ceiling, and says when it was capped', () => {
    const decision = selectTier(caps(), 'small');
    expect(decision.tier).toBe('small');
    expect(decision.capped).toBe(true);

    // The default ceiling: a capable device still does not get a 450MB download
    // unless the site opts in.
    expect(selectTier(caps(), 'retrieval').tier).toBe('retrieval');
  });

  it('does not mark a decision capped when the device was the limit', () => {
    expect(selectTier(caps({ webgpu: false }), 'standard').capped).toBe(false);
  });

  it('lets deviceMemory downgrade but never gate', () => {
    // Present and low: downgrade from standard.
    expect(selectTier(caps({ deviceMemoryGb: 4 }), 'standard').tier).toBe('small');
    // Absent, as on Safari: must not be treated as low.
    expect(selectTier(caps({ deviceMemoryGb: null }), 'standard').tier).toBe('standard');
  });

  it('does not refuse a device that simply reports no limits', () => {
    // Some adapters omit these. Refusing on absence would exclude working hardware.
    const decision = selectTier(
      caps({ maxBufferSize: null, maxStorageBufferBindingSize: null, deviceMemoryGb: null }),
      'standard',
    );
    expect(decision.tier).toBe('small');
  });
});
