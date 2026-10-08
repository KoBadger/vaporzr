import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
import { replicateStemsEnabled, separateStemsReplicate } from '@vaporzr/core/stemSeparation';

const origToken = config.replicateApiToken;

afterEach(() => {
  config.replicateApiToken = origToken;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('replicate stem separation', () => {
  it('is disabled without a token (local Demucs stays the default)', async () => {
    config.replicateApiToken = '';
    expect(replicateStemsEnabled()).toBe(false);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stems-off-'));
    expect(await separateStemsReplicate('/does/not/exist.mp3', dir)).toBeNull();
  });

  it('uploads, predicts, polls and downloads both stems', async () => {
    config.replicateApiToken = 'test-token';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stems-on-'));
    const input = path.join(dir, 'in.mp3');
    await fs.writeFile(input, Buffer.from('audio'));

    const calls: string[] = [];
    let polls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        calls.push(`${init?.method ?? 'GET'} ${u}`);
        if (u.endsWith('/files')) {
          return new Response(JSON.stringify({ urls: { get: 'https://files.example/abc' } }), { status: 200 });
        }
        if (u.endsWith('/predictions') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 'p1', status: 'starting' }), { status: 200 });
        }
        if (u.endsWith('/predictions/p1')) {
          polls++;
          return new Response(
            JSON.stringify({ id: 'p1', status: 'succeeded', output: { vocals: 'https://out.example/v.mp3', no_vocals: 'https://out.example/nv.mp3' } }),
            { status: 200 },
          );
        }
        if (u === 'https://out.example/v.mp3' || u === 'https://out.example/nv.mp3') {
          return new Response(Buffer.from('stem-bytes'), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }),
    );

    const r = await separateStemsReplicate(input, dir);
    expect(r).not.toBeNull();
    expect(r!.vocals.endsWith('vocals.mp3')).toBe(true);
    expect(r!.other.endsWith('no_vocals.mp3')).toBe(true);
    expect((await fs.readFile(r!.vocals)).toString()).toBe('stem-bytes');
    expect((await fs.readFile(r!.other)).toString()).toBe('stem-bytes');
    expect(polls).toBeGreaterThanOrEqual(1);
    expect(calls.some((c) => c.startsWith('POST https://api.replicate.com/v1/files'))).toBe(true);
    expect(calls.some((c) => c.startsWith('POST https://api.replicate.com/v1/models/cjwbw/demucs/predictions'))).toBe(true);
  });

  it('falls back (returns null) when the prediction fails', async () => {
    config.replicateApiToken = 'test-token';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stems-fail-'));
    const input = path.join(dir, 'in.mp3');
    await fs.writeFile(input, Buffer.from('audio'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/files')) return new Response(JSON.stringify({ urls: { get: 'https://files.example/abc' } }), { status: 200 });
        if (u.endsWith('/predictions') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 'p2', status: 'failed', error: 'boom' }), { status: 200 });
        }
        return new Response('nope', { status: 404 });
      }),
    );
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await separateStemsReplicate(input, dir)).toBeNull();
    expect(spy).toHaveBeenCalled();
  });
});
