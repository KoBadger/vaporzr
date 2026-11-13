import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

// Same reason as the other AMOK tests: the store writes under DATA_DIR, so give
// this file its own throwaway directory instead of whatever the machine has.
vi.hoisted(() => {
  const g = globalThis as { __amokSettingsPrevDataDir?: string };
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp';
  g.__amokSettingsPrevDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = `${base}/vaporzr-amok-settings-test-${process.pid}`;
});

import {
  amokSettings,
  amokSettingsStatus,
  clearAmokSettings,
  resetAmokSettingsCache,
  saveAmokSettings,
} from '../amokSettings.js';
import { amokProviderChain } from '../amokProvider.js';

// The panel writes this file. It holds a bearer key, so the rules worth pinning
// are: it never leaves the process in clear text, a blank key does not erase a
// working one, and a bad provider name is rejected rather than silently stored.

const PROVIDER_ENV = [
  'AMOK_PROVIDER',
  'AMOK_API_KEY',
  'AMOK_MODEL',
  'AMOK_FALLBACK',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of PROVIDER_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  clearAmokSettings();
  resetAmokSettingsCache();
});

afterAll(() => {
  const g = globalThis as { __amokSettingsPrevDataDir?: string };
  try {
    rmSync(process.env.DATA_DIR ?? '', { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  for (const key of PROVIDER_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  if (g.__amokSettingsPrevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = g.__amokSettingsPrevDataDir;
});

describe('amokSettings', () => {
  it('starts empty', () => {
    expect(amokSettings()).toEqual({});
    expect(amokSettingsStatus().configured).toBe(false);
  });

  it('stores a provider and a key', () => {
    expect(saveAmokSettings({ provider: 'openrouter', apiKey: 'sk-or-abcdef123456' }).ok).toBe(true);
    const status = amokSettingsStatus();
    expect(status.provider).toBe('openrouter');
    expect(status.configured).toBe(true);
    expect(amokSettings().apiKey).toBe('sk-or-abcdef123456');
  });

  it('never returns the key, only a masked hint', () => {
    saveAmokSettings({ provider: 'openrouter', apiKey: 'sk-or-abcdef123456' });
    const status = amokSettingsStatus();
    expect(status.hint).toBe('sk-or-…3456');
    expect(JSON.stringify(status)).not.toContain('abcdef');
  });

  it('keeps the existing key when the field is submitted blank', () => {
    saveAmokSettings({ provider: 'openrouter', apiKey: 'sk-or-abcdef123456' });
    saveAmokSettings({ provider: 'openrouter', apiKey: '' });
    expect(amokSettings().apiKey).toBe('sk-or-abcdef123456');
  });

  it('rejects an unknown provider', () => {
    const result = saveAmokSettings({ provider: 'myspace', apiKey: 'x' });
    expect(result.ok).toBe(false);
    expect(amokSettings().provider).toBeUndefined();
  });

  it('normalises provider case and trims values', () => {
    saveAmokSettings({ provider: '  OpenRouter  ', apiKey: '  sk-or-zzz  ' });
    expect(amokSettings().provider).toBe('openrouter');
    expect(amokSettings().apiKey).toBe('sk-or-zzz');
  });

  it('clears back to nothing', () => {
    saveAmokSettings({ provider: 'groq', apiKey: 'gsk-1' });
    clearAmokSettings();
    resetAmokSettingsCache();
    expect(amokSettings()).toEqual({});
  });
});

describe('settings feed the provider chain', () => {
  it('uses the saved provider without any env', () => {
    saveAmokSettings({ provider: 'openrouter', apiKey: 'sk-or-test' });
    resetAmokSettingsCache();
    expect(amokProviderChain()).toContain('openrouter');
  });

  it('lets deployment env win over the saved provider', () => {
    saveAmokSettings({ provider: 'groq', apiKey: 'gsk-saved' });
    process.env.AMOK_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-env';
    resetAmokSettingsCache();
    expect(amokProviderChain()[0]).toBe('openrouter');
  });

  it('is empty again after clearing when no env is set', () => {
    saveAmokSettings({ provider: 'openrouter', apiKey: 'sk-or-test' });
    clearAmokSettings();
    resetAmokSettingsCache();
    expect(amokProviderChain()).toEqual([]);
  });
});
