import fs from 'node:fs';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
import { writeJsonAtomicSync } from './jsonFile.js';

interface StoredDomain {
  host: string;
  updatedAt: number;
}

interface StoreData {
  guilds: Record<string, StoredDomain>;
}

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Normalise and validate an operator-supplied hostname. Accepts a bare host,
 *  or a full https URL (the scheme/path are stripped). Returns the lower-case
 *  hostname, or null when it cannot be a public DNS name. */
export function normalizeDomain(input: string): string | null {
  let raw = String(input ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (raw.includes('://')) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      if (u.pathname !== '/' && u.pathname !== '') return null;
      raw = u.hostname;
    } catch {
      return null;
    }
  }
  raw = raw.replace(/\.$/, '');
  // No ports, paths, wildcards or credentials.
  if (/[:/\\@?#*]/.test(raw)) return null;
  // Local/private names are not something a public certificate can serve.
  if (raw === 'localhost' || raw.endsWith('.local') || raw.endsWith('.internal')) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)) return null;
  if (!HOST_RE.test(raw)) return null;
  return raw;
}

/** The deployment's own hostname: a guild cannot claim it. */
function deploymentHost(): string {
  for (const base of [config.staticBaseUrl, config.jamPublicBase]) {
    if (!base) continue;
    try {
      return new URL(base).hostname.toLowerCase();
    } catch {
      /* ignore */
    }
  }
  return '';
}

/**
 * Per-guild custom domains for white-label links. The domain is a hostname the
 * operator points at this deployment; the app does not manage DNS or TLS.
 *
 * A hostname maps to at most one guild, so routing a request by Host is
 * unambiguous. The store is a single JSON document because the set is tiny
 * (one row per paying server) and every lookup is in memory.
 */
export class DomainStore {
  private cache: StoreData | null = null;

  private file(): string {
    return path.join(config.dataDir, 'domains.json');
  }

  private load(): StoreData {
    if (this.cache) return this.cache;
    let data: StoreData = { guilds: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as Partial<StoreData>;
      if (parsed.guilds && typeof parsed.guilds === 'object') {
        data = { guilds: parsed.guilds as Record<string, StoredDomain> };
      }
    } catch {
      /* fresh */
    }
    this.cache = data;
    return data;
  }

  private save(data: StoreData): void {
    try {
      writeJsonAtomicSync(this.file(), data);
    } catch (err) {
      console.warn('[domains] save failed:', err instanceof Error ? err.message : err);
    }
  }

  /** The custom hostname for a guild, if one is configured. */
  hostFor(guildId: string): string | null {
    if (!guildId) return null;
    return this.load().guilds[guildId]?.host ?? null;
  }

  /** Public base URL (https://host) for a guild, or null when it uses the
   *  deployment default. */
  baseFor(guildId: string): string | null {
    const host = this.hostFor(guildId);
    return host ? `https://${host}` : null;
  }

  /** Reverse lookup used when a request arrives on a custom Host. */
  guildForHost(host: string | undefined): string | null {
    // Incoming Host headers include the port; the store only holds hostnames.
    const bare = String(host ?? '')
      .trim()
      .replace(/:\d{1,5}$/, '');
    const clean = normalizeDomain(bare);
    if (!clean) return null;
    const data = this.load();
    for (const [guildId, row] of Object.entries(data.guilds)) {
      if (row.host === clean) return guildId;
    }
    return null;
  }

  /** Claim a hostname for a guild. Returns an error string when invalid or
   *  already taken by another guild. */
  set(guildId: string, input: string): { host: string } | { error: string } {
    if (!guildId) return { error: 'No server selected.' };
    const host = normalizeDomain(input);
    if (!host) return { error: 'Enter a bare hostname, e.g. music.example.com.' };
    if (host === deploymentHost()) return { error: 'That is this deployment’s own hostname.' };
    const data = this.load();
    for (const [otherGuild, row] of Object.entries(data.guilds)) {
      if (otherGuild !== guildId && row.host === host) {
        return { error: 'That hostname is already used by another server.' };
      }
    }
    data.guilds[guildId] = { host, updatedAt: Date.now() };
    this.save(data);
    return { host };
  }

  clear(guildId: string): boolean {
    const data = this.load();
    if (!data.guilds[guildId]) return false;
    delete data.guilds[guildId];
    this.save(data);
    return true;
  }
}

export const domainStore = new DomainStore();
