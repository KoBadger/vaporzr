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

  it('rotates the sticky PORT when there is no sessid (datacenter plans)', () => {
    // DataImpulse documents sessid for residential only; on datacenter the
    // sticky exit is bound to the port, so rotation must move the port.
    config.youtubeProxy = 'http://acct:pw@gw.dataimpulse.com:10007';
    const out = rotateYoutubeProxy();
    expect(out).toContain('acct:pw@');
    expect(out).not.toContain(':10007');
    const port = Number(/:(\d{4,5})$/.exec(out)?.[1]);
    expect(port).toBeGreaterThanOrEqual(10000);
    expect(port).toBeLessThanOrEqual(20000);
  });

  it('falls back to a sessid when the port is not a sticky port', () => {
    config.youtubeProxy = 'http://acct:pw@gw.dataimpulse.com:823';
    const out = rotateYoutubeProxy();
    expect(out).toContain('sessid.');
    expect(out).toContain('gw.dataimpulse.com:823');
  });

  it('is a no-op without a proxy', () => {
    config.youtubeProxy = '';
    expect(rotateYoutubeProxy()).toBe('');
  });
});
