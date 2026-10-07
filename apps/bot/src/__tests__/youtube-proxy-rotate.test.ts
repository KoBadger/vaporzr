import { afterEach, describe, expect, it } from 'vitest';
import { config } from '@vaporzr/core/config';
import { rotateYoutubeProxy } from '@vaporzr/core/youtube';

describe('rotateYoutubeProxy', () => {
  const original = config.youtubeProxy;
  afterEach(() => {
    config.youtubeProxy = original;
  });

  it('replaces an existing sticky sessid with a new one', () => {
    config.youtubeProxy = 'http://acct__sessid.vz3;sessttl.60:pw@gw.dataimpulse.com:10000';
    const out = rotateYoutubeProxy();
    expect(out).toContain('sessid.');
    expect(out).not.toContain('sessid.vz3');
    expect(out).toContain('sessttl.60');
    expect(out).toContain('gw.dataimpulse.com:10000');
  });

  it('adds a sessid when none is present', () => {
    config.youtubeProxy = 'http://acct:pw@gw.dataimpulse.com:10000';
    const out = rotateYoutubeProxy();
    expect(out).toContain('sessid.');
    expect(out).toContain('gw.dataimpulse.com:10000');
  });

  it('is a no-op without a proxy', () => {
    config.youtubeProxy = '';
    expect(rotateYoutubeProxy()).toBe('');
  });
});
