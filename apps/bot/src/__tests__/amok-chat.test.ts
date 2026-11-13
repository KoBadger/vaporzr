import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askAmokRich } from '../amok.js';

// End-to-end shape of one chat turn: which URL is called, what the persona
// looks like on the wire, and whether a dead primary actually falls through to
// the backup. The provider layer itself is unit-tested in
// amok-provider.test.ts; this file pins the contract `askAmokRich` relies on.

const ENV_KEYS = ['AMOK_PROVIDER', 'AMOK_API_KEY', 'AMOK_MODEL', 'AMOK_FALLBACK', 'AMOK_DIALOGFLOW'] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of [...ENV_KEYS, 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'] as const) {
    if (key in saved) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    } else {
      delete process.env[key as string];
    }
  }
});

interface Captured {
  url: string;
  body: { model?: string; messages: Array<{ role: string; content: string }> };
}

function respondWith(content: string) {
  const calls: Captured[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

describe('askAmokRich on the OpenRouter chain', () => {
  it('sends the HAL persona as a system message', async () => {
    process.env.AMOK_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const calls = respondWith('I am fully operational.');

    const result = await askAmokRich('are you there', { scopeId: 'g1', userId: 'u1' });

    expect(result.text).toBe('I am fully operational.');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('openrouter.ai');
    expect(calls[0]!.body.messages[0]!.role).toBe('system');
    // Guards against the persona silently reverting to the old surfer prompt.
    expect(calls[0]!.body.messages[0]!.content).toContain('AMOK 9000');
    expect(calls[0]!.body.messages[1]!.content).toContain('are you there');
  });

  it('parses a queue request out of the reply', async () => {
    process.env.AMOK_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    respondWith('Loading that now.\nAMOK_QUEUE: Sublime - Santeria');

    const result = await askAmokRich('play santeria', { scopeId: 'g1', userId: 'u1', forceRoomContext: true });

    expect(result.queueQueries).toEqual(['Sublime - Santeria']);
    expect(result.text).toBe('Loading that now.');
  });

  it('falls through to the backup provider when the primary errors', async () => {
    process.env.AMOK_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.AMOK_FALLBACK = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';

    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url));
      if (String(url).includes('openrouter')) {
        return new Response('rate limited', { status: 429 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Falling back.' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await askAmokRich('status report', { scopeId: 'g1', userId: 'u1' });

    expect(result.text).toBe('Falling back.');
    expect(urls[0]).toContain('openrouter');
    expect(urls[1]).toContain('api.openai.com');
  });

  it('reports which providers failed when every one of them errors', async () => {
    process.env.AMOK_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));

    // The message has to name the provider and the status: "something went
    // wrong" is not actionable at 2am, and a bare 500 does not say whose.
    await expect(askAmokRich('anyone home', { scopeId: 'g1', userId: 'u1' })).rejects.toThrow(/openrouter: HTTP 500/);
  });
});
