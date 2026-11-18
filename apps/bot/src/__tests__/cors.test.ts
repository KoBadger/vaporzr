import { describe, expect, it } from 'vitest';
import { allowedOrigin } from '../cors.js';

const BASES = ['https://www.vaporzr.app', 'https://vaporzr.app'];

describe('allowedOrigin', () => {
  it('grants nothing to a same-origin request (it needs no header)', () => {
    expect(allowedOrigin(undefined, BASES)).toBeNull();
  });

  it('echoes a configured public origin', () => {
    expect(allowedOrigin('https://www.vaporzr.app', BASES)).toBe('https://www.vaporzr.app');
  });

  it('refuses an unrelated site', () => {
    // The old blanket `*` let any page read whatever a same-origin request could.
    expect(allowedOrigin('https://evil.example', BASES)).toBeNull();
  });

  it('refuses a look-alike host', () => {
    expect(allowedOrigin('https://www.vaporzr.app.evil.example', BASES)).toBeNull();
  });

  it('allows loopback for local development, any port', () => {
    expect(allowedOrigin('http://localhost:4876', BASES)).toBe('http://localhost:4876');
    expect(allowedOrigin('http://127.0.0.1:3000', [])).toBe('http://127.0.0.1:3000');
  });

  it('allows the file:// origin the desktop visualizer sends', () => {
    expect(allowedOrigin('null', BASES)).toBe('null');
    expect(allowedOrigin('null', BASES, { allowNull: false })).toBeNull();
  });

  it('ignores malformed origins and malformed configured bases', () => {
    expect(allowedOrigin('not a url', BASES)).toBeNull();
    expect(allowedOrigin('https://www.vaporzr.app', ['not a url'])).toBeNull();
  });
});
