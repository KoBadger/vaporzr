import { describe, expect, it } from 'vitest';
import { orderBySonic, SHUFFLE_MODE_LABEL } from '@vaporzr/core/smartShuffle';

describe('sonic shuffle ordering', () => {
  it('orders by descending similarity and keeps unknowns at the end', () => {
    const items = ['a', 'b', 'c', 'd'];
    const scores: Record<string, number> = { a: 0.2, b: 0.9, c: 0.5 };
    const { ordered, withoutFeatures } = orderBySonic(items, (t) => scores[t]);
    expect(ordered).toEqual(['b', 'c', 'a', 'd']);
    expect(withoutFeatures).toBe(1);
  });

  it('returns the original order when fewer than two items are scored', () => {
    const items = ['a', 'b', 'c'];
    const { ordered, withoutFeatures } = orderBySonic(items, (t) => (t === 'a' ? 0.5 : undefined));
    expect(ordered).toEqual(['a', 'b', 'c']);
    expect(withoutFeatures).toBe(2);
  });

  it('exposes a label for the sonic mode', () => {
    expect(SHUFFLE_MODE_LABEL.sonic).toContain('cosine');
  });
});
