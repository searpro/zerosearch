import { describe, expect, it } from 'vitest';
import { TIERS, minTier, tierAtMost } from '../../src/types.js';

describe('tier ordering', () => {
  it('orders cheapest first', () => {
    expect(TIERS).toEqual(['retrieval', 'small', 'standard']);
  });

  it('tierAtMost compares by capability', () => {
    expect(tierAtMost('retrieval', 'standard')).toBe(true);
    expect(tierAtMost('standard', 'retrieval')).toBe(false);
    expect(tierAtMost('small', 'small')).toBe(true);
  });

  it('minTier is what caps a device probe against the site ceiling', () => {
    expect(minTier('standard', 'small')).toBe('small');
    expect(minTier('retrieval', 'standard')).toBe('retrieval');
  });
});
