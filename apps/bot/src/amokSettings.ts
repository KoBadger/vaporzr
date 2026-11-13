import fs from 'node:fs';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
import { writeJsonAtomicSync } from './jsonFile.js';

/**
 * AMOK's provider settings, editable from the panel.
 *
 * The deployment env file is the wrong place for this: changing it means SSH,
 * editing `/opt/vaporzr/.env` and recreating the container, because `--env-file`
 * is read at container-create time. When the AI provider is down, that is
 * exactly the moment nobody wants to be doing Docker surgery.
 *
 * So the key lives here instead — in `config.dataDir`, which is the mounted
 * volume, so it survives deploys and image changes. Env still wins when it is
 * set, which keeps a deployment that manages its own config authoritative.
 *
 * The file is written 0600 and nothing ever reads the key back out over HTTP;
 * the panel only ever sees a masked hint.
 */

export interface AmokSettings {
  provider?: string;
  apiKey?: string;
  model?: string;
  fallback?: string;
  updatedAt?: number;
}

/** Providers the adapter layer knows how to talk to. */
const PROVIDERS = new Set(['openrouter', 'openai', 'anthropic', 'groq', 'google', 'vertex']);

let cache: AmokSettings | null = null;

function settingsFile(): string {
  return path.join(config.dataDir, 'amok-ai.json');
}

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function sanitize(input: Partial<AmokSettings>): AmokSettings {
  const out: AmokSettings = {};
  const provider = clean(input.provider, 24)?.toLowerCase();
  if (provider && PROVIDERS.has(provider)) out.provider = provider;
  const apiKey = clean(input.apiKey, 400);
  if (apiKey) out.apiKey = apiKey;
  const model = clean(input.model, 120);
  if (model) out.model = model;
  const fallback = clean(input.fallback, 200);
  if (fallback) out.fallback = fallback;
  if (typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt)) out.updatedAt = input.updatedAt;
  return out;
}

/** Current settings. Cached: this is read on every chat turn. */
export function amokSettings(): AmokSettings {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as unknown;
    cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? sanitize(raw as Partial<AmokSettings>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

/**
 * Merge a patch into the stored settings.
 *
 * `apiKey: ''` is treated as "leave it alone", not "delete it": the panel shows
 * a masked field, and re-saving the form without retyping must not wipe a
 * working key. Removal is an explicit `clearAmokSettings()`.
 */
export function saveAmokSettings(patch: Partial<AmokSettings>): { ok: true } | { ok: false; error: string } {
  const requested = (patch.provider ?? '').trim().toLowerCase();
  if (requested && !PROVIDERS.has(requested)) {
    return { ok: false, error: `Unknown provider "${patch.provider}".` };
  }
  // A blank string means "leave this alone", not "erase it": the panel renders
  // the key as a masked field, so re-saving the form must not drop a working
  // credential. Removal is an explicit `clearAmokSettings()`.
  const incoming: Partial<AmokSettings> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === 'string' && !value.trim()) continue;
    if (value === undefined || value === null) continue;
    (incoming as Record<string, unknown>)[key] = value;
  }
  const merged = sanitize({ ...amokSettings(), ...incoming });
  cache = { ...merged, updatedAt: Date.now() };
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    writeJsonAtomicSync(settingsFile(), cache);
    try {
      // The key is a bearer credential; keep it off other accounts on the box.
      fs.chmodSync(settingsFile(), 0o600);
    } catch {
      /* Windows and some mounts have no POSIX modes */
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not save settings.' };
  }
  return { ok: true };
}

/** Forget the stored provider entirely; env (if any) takes over again. */
export function clearAmokSettings(): void {
  cache = {};
  try {
    fs.rmSync(settingsFile(), { force: true });
  } catch {
    /* nothing to remove */
  }
}

/** Panel-safe view: never includes the key. */
export function amokSettingsStatus(): {
  provider: string;
  model: string;
  fallback: string;
  configured: boolean;
  hint: string;
  updatedAt: number | null;
} {
  const s = amokSettings();
  const key = s.apiKey ?? '';
  return {
    provider: s.provider ?? '',
    model: s.model ?? '',
    fallback: s.fallback ?? '',
    configured: Boolean(key),
    hint: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '',
    updatedAt: s.updatedAt ?? null,
  };
}

/** Reset the cache. Tests use this; the panel does not need it. */
export function resetAmokSettingsCache(): void {
  cache = null;
}
