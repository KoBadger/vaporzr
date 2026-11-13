import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { amokChat, amokConfigured, amokGroundedFacts, amokProviderChain } from '../amokProvider.js';

// The chain is pure configuration logic: which providers exist and what order
// they are tried in. No network here - these tests pin the decisions that
// decide whether AMOK works at all after someone edits an .env file at 2am.

const KEYS = [
  'AMOK_PROVIDER',
  'AMOK_API_KEY',
  'AMOK_MODEL',
  'AMOK_FALLBACK',
  'AMOK_TIMEOUT_MS',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_AI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('amokProviderChain', () => {
  it('is empty when nothing is configured', () => {
    expect(amokProviderChain()).toEqual([]);
    expect(amokConfigured()).toBe(false);
  });

  it('picks the explicit provider when its key is present', () => {
    process.env.AMOK_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    expect(amokProviderChain()).toEqual(['openrouter']);
  });

  it('drops an explicitly chosen provider that has no key', () => {
    process.env.AMOK_PROVIDER = 'anthropic';
    expect(amokProviderChain()).toEqual([]);
  });

  it('defaults to OpenRouter when only that key is set', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    expect(amokProviderChain()).toEqual(['openrouter']);
  });

  it('accepts AMOK_API_KEY as the key for the chosen provider', () => {
    process.env.AMOK_PROVIDER = 'groq';
    process.env.AMOK_API_KEY = 'gsk-test';
    expect(amokProviderChain()).toEqual(['groq']);
  });

  it('walks the fallback list in order and de-duplicates', () => {
    process.env.AMOK_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.AMOK_FALLBACK = 'openai, openai , groq';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GROQ_API_KEY = 'gsk-test';
    expect(amokProviderChain()).toEqual(['openrouter', 'openai', 'groq']);
  });

  it('skips providers named in the fallback list that have no key', () => {
    process.env.AMOK_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.AMOK_FALLBACK = 'anthropic,google';
    expect(amokProviderChain()).toEqual(['openrouter']);
  });

  it('ignores a provider it has never heard of', () => {
    process.env.AMOK_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.AMOK_FALLBACK = 'myspace';
    expect(amokProviderChain()).toEqual(['openrouter']);
  });

  it('does not register Vertex without Google credentials', () => {
    // `amokProvider.ts` never registers Vertex itself; `amok.ts` does, and only
    // when ADC credentials load. Importing the provider module directly must
    // therefore never offer a Google route that cannot work.
    process.env.AMOK_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.AMOK_FALLBACK = 'vertex';
    expect(amokProviderChain()).not.toContain('vertex');
  });
});

describe('amokChat with no provider', () => {
  it('fails with an actionable message instead of a network error', async () => {
    await expect(amokChat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /No AI provider is configured/,
    );
  });
});

describe('amokGroundedFacts with no provider', () => {
  it('returns null so the caller answers from model knowledge', async () => {
    await expect(amokGroundedFacts('what is the weather')).resolves.toBeNull();
  });
});
