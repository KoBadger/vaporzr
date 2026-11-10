import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '@vaporzr/core/config';
import { handleVideoProxy } from '../videoProxy.js';

function fakeRes(): ServerResponse & { statusCode: number; body: string } {
  const res = {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, string>,
    writeHead(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k] = v;
    },
    end(chunk?: string) {
      if (chunk) res.body += chunk;
    },
  };
  return res as unknown as ServerResponse & { statusCode: number; body: string };
}

describe('video proxy allowlist', () => {
  const original = config.dataDir;
  let tmp = '';

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-video-'));
    config.dataDir = tmp;
  });

  afterAll(() => {
    config.dataDir = original;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses to start a download for an id the bot is not playing', () => {
    // /api/video cannot use a cookie (the Activity iframe cannot carry one), so
    // an unconstrained id would make this an open yt-dlp trigger on paid proxy
    // traffic. Only what is playing may start a job.
    const res = fakeRes();
    handleVideoProxy(
      { method: 'GET', headers: {} } as unknown as IncomingMessage,
      res,
      'dQw4w9WgXcQ',
      new URL('https://example.test/api/video/dQw4w9WgXcQ'),
      new Set(['AAAAAAAAAAA']),
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ status: 'forbidden' });
  });

  it('refuses when the bot has nothing playing at all', () => {
    const res = fakeRes();
    handleVideoProxy(
      { method: 'GET', headers: {} } as unknown as IncomingMessage,
      res,
      'dQw4w9WgXcQ',
      new URL('https://example.test/api/video/dQw4w9WgXcQ'),
      new Set(),
    );
    expect(res.statusCode).toBe(403);
  });

  it('still rejects a malformed id before consulting the allowlist', () => {
    const res = fakeRes();
    handleVideoProxy(
      { method: 'GET', headers: {} } as unknown as IncomingMessage,
      res,
      '../etc/passwd',
      new URL('https://example.test/api/video/x'),
      new Set(['..%2Fetc%2Fpasswd']),
    );
    expect(res.statusCode).toBe(400);
  });
});
