import { describe, expect, it } from 'vitest';
import { secretEquals } from '../secretCompare.js';

describe('secretEquals', () => {
  it('accepts matching values', () => {
    expect(secretEquals('s3cret-key', 's3cret-key')).toBe(true);
  });

  it('rejects differing values, including different lengths', () => {
    expect(secretEquals('s3cret-key', 's3cret-ke')).toBe(false);
    expect(secretEquals('s3cret-key', 'other-value')).toBe(false);
  });

  it('rejects empty or missing values (never treats blank as a match)', () => {
    expect(secretEquals('', '')).toBe(false);
    expect(secretEquals(undefined, 'x')).toBe(false);
    expect(secretEquals('x', undefined)).toBe(false);
    expect(secretEquals(null, null)).toBe(false);
  });
});
