import { afterEach, describe, expect, it } from 'vitest';
import { config } from '@vaporzr/core/config';
import { rotateYoutubeFallbackProxy } from '@vaporzr/core/youtube';

describe('rotateYoutubeFallbackProxy', () => {
  const original = config.youtubeProxyFallback;
  afterEach(() => {
    config.youtubeProxyFallback = original;
  });

  it('replaces an existing sticky sessid with a new one', () => {
    config.youtubeProxyFallback = 'http://acct__sessid.vz3;sessttl.60:pw@gw.dataimpulse.com:10000';
    const out = rotateYoutubeFallbackProxy();
    expect(out).toContain('sessid.');
    expect(out).not.toContain('sessid.vz3');
    expect(out).toContain('sessttl.60');
    expect(out).toContain('gw.dataimpulse.com:10000');
    // The config is updated in place too, so the next resolve uses the new exit.
    expect(config.youtubeProxyFallback).toBe(out);
  });

  it('rotates the sticky PORT when there is no sessid (datacenter plans)', () => {
    // DataImpulse documents sessid for residential only; on datacenter the
    // sticky exit is bound to the port, so rotation must move the port.
    config.youtubeProxyFallback = 'http://acct:pw@gw.dataimpulse.com:10007';
    const out = rotateYoutubeFallbackProxy();
    expect(out).toContain('acct:pw@');
    expect(out).not.toContain(':10007');
    const port = Number(/:(\d{4,5})$/.exec(out)?.[1]);
    expect(port).toBeGreaterThanOrEqual(10000);
    expect(port).toBeLessThanOrEqual(20000);
  });

  it('falls back to a sessid when the port is not a sticky port', () => {
    config.youtubeProxyFallback = 'http://acct:pw@gw.dataimpulse.com:823';
    const out = rotateYoutubeFallbackProxy();
    expect(out).toContain('sessid.');
    expect(out).toContain('gw.dataimpulse.com:823');
  });

  it('is a no-op without a fallback proxy', () => {
    config.youtubeProxyFallback = '';
    expect(rotateYoutubeFallbackProxy()).toBe('');
  });

  it('leaves a fixed, non-rotating endpoint alone', () => {
    // A local WARP proxy (or any fixed hop) has no session syntax; appending
    // `;sessid.x` to its username would corrupt the URL and break the hop.
    config.youtubeProxyFallback = 'http://127.0.0.1:40000';
    expect(rotateYoutubeFallbackProxy()).toBe('');
    expect(config.youtubeProxyFallback).toBe('http://127.0.0.1:40000');
  });
});
