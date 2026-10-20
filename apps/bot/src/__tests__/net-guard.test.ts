import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockedFetchError, filterPublicAddresses, isBlockedFetchHost, safeFetch } from '@vaporzr/core/net';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isBlockedFetchHost', () => {
  it.each([
    'localhost',
    'vapor.localhost',
    'printer.local',
    'jira.internal',
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.10',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
  ])('blocks %s', (host) => {
    expect(isBlockedFetchHost(host)).toBe(true);
  });

  it.each(['example.com', '8.8.8.8', '1.1.1.1', '172.32.0.1', '11.0.0.1', '2001:4860:4860::8888'])(
    'allows %s',
    (host) => {
      expect(isBlockedFetchHost(host)).toBe(false);
    },
  );

  it('sees through legacy IPv4 spellings via WHATWG normalization', () => {
    // 2130706433 = 127.0.0.1; hex form 0x7f.1 = 127.0.0.1.
    expect(isBlockedFetchHost(new URL('http://2130706433/').hostname)).toBe(true);
    expect(isBlockedFetchHost(new URL('http://0x7f.1/').hostname)).toBe(true);
  });
});

describe('filterPublicAddresses', () => {
  it('keeps public answers and drops private ones (DNS rebinding guard)', () => {
    expect(filterPublicAddresses([{ address: '93.184.216.34', family: 4 }])).toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
    expect(
      filterPublicAddresses([
        { address: '10.0.0.5', family: 4 },
        { address: '93.184.216.34', family: 4 },
      ]),
    ).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('returns nothing when every answer is private', () => {
    expect(
      filterPublicAddresses([
        { address: '10.0.0.5', family: 4 },
        { address: '127.0.0.1', family: 4 },
        { address: 'fe80::1', family: 6 },
      ]),
    ).toEqual([]);
  });
});

describe('safeFetch', () => {
  it('refuses a private host without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(safeFetch('http://127.0.0.1:8080/x.mp3')).rejects.toBeInstanceOf(BlockedFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses non-http(s) protocols', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(safeFetch('ftp://example.com/x.mp3')).rejects.toBeInstanceOf(BlockedFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not follow a redirect into a private address', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(safeFetch('https://example.com/media.mp3')).rejects.toBeInstanceOf(BlockedFetchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows a public redirect chain and returns the final response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/a.mp3' } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await safeFetch('https://example.com/a.mp3', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('https://cdn.example.net/a.mp3');
    const firstInit = fetchMock.mock.calls[0][1] as RequestInit & { dispatcher?: unknown };
    expect(firstInit.redirect).toBe('manual');
    // The DNS-pinning connector rides along on every hop.
    expect(firstInit.dispatcher).toBeDefined();
  });
});
