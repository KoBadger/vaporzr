import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { downloadToTempFile } from '../mediaDownload.js';

const ok = (body: string) => new Response(Buffer.from(body), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('downloadToTempFile refresh-on-403', () => {
  it('re-mints the URL and retries when the first attempt is rejected', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return calls === 1 ? new Response('', { status: 403 }) : ok('hello');
      }),
    );
    let refreshed = 0;
    const file = await downloadToTempFile('https://x/one', undefined, async () => {
      refreshed++;
      return 'https://x/two';
    });
    expect(file).toBeTruthy();
    expect(refreshed).toBe(1);
    expect(fs.readFileSync(file!, 'utf8')).toBe('hello');
    fs.rmSync(file!, { force: true });
  });

  it('does not refresh on a non-retryable status (e.g. 404)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    let refreshed = 0;
    const file = await downloadToTempFile('https://x/one', undefined, async () => {
      refreshed++;
      return 'https://x/two';
    });
    expect(file).toBeNull();
    expect(refreshed).toBe(0);
  });

  it('returns null on 403 when no refresh callback is supplied', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    const file = await downloadToTempFile('https://x/one');
    expect(file).toBeNull();
  });

  it('gives up gracefully when the refreshed URL is also rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    let refreshed = 0;
    const file = await downloadToTempFile('https://x/one', undefined, async () => {
      refreshed++;
      return 'https://x/two';
    });
    expect(file).toBeNull();
    // 1 original + up to 2 refreshed attempts → at most 2 refreshes.
    expect(refreshed).toBe(2);
  });
});
