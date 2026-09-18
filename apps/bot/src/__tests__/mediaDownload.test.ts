import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { downloadToTempFile } from '../mediaDownload.js';

describe('downloadToTempFile', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('writes ranged chunks to a temp file and stops at EOF', async () => {
    const payload = Buffer.from('0123456789');
    const starts: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
        const start = m ? Number(m[1]) : 0;
        starts.push(start);
        if (start >= payload.length) return { status: 416, arrayBuffer: async () => new ArrayBuffer(0) };
        const body = payload.subarray(start);
        return {
          status: 206,
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
        };
      }),
    );

    const file = await downloadToTempFile('https://example.test/media', 1024);
    expect(file).toBeTruthy();
    expect(fs.readFileSync(file!).toString()).toBe('0123456789');
    fs.rmSync(file!, { force: true });
    expect(starts[0]).toBe(0);
  });

  it('returns null and leaves no file when the server rejects the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 403, arrayBuffer: async () => new ArrayBuffer(0) })));
    expect(await downloadToTempFile('https://example.test/media')).toBeNull();
  });
});
