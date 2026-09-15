import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/** A queueable track persisted in a saved playlist (stream URL resolved on load). */
export interface SavedTrack {
  uri: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  source: string;
  image?: string;
}

export interface SavedPlaylist {
  name: string;
  tracks: SavedTrack[];
  updatedAt: number;
}

const MAX_PER_GUILD = 25;
const MAX_TRACKS = 200;

function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Per-guild saved playlists (favorites), persisted to data/playlists/<guildId>.json. */
export class PlaylistStore {
  private cache = new Map<string, Record<string, SavedPlaylist>>();

  private fileFor(guildId: string): string {
    return path.join(config.dataDir, 'playlists', `${guildId}.json`);
  }

  private load(guildId: string): Record<string, SavedPlaylist> {
    const cached = this.cache.get(guildId);
    if (cached) return cached;
    let data: Record<string, SavedPlaylist> = {};
    try {
      data = JSON.parse(fs.readFileSync(this.fileFor(guildId), 'utf8')) as Record<string, SavedPlaylist>;
      if (!data || typeof data !== 'object') data = {};
    } catch {
      data = {};
    }
    this.cache.set(guildId, data);
    return data;
  }

  private persist(guildId: string): void {
    const data = this.load(guildId);
    try {
      const file = this.fileFor(guildId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (err) {
      console.warn('[playlists] save failed:', err instanceof Error ? err.message : err);
    }
  }

  list(guildId: string): SavedPlaylist[] {
    return Object.values(this.load(guildId)).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(guildId: string, name: string): SavedPlaylist | null {
    return this.load(guildId)[normalizeName(name)] ?? null;
  }

  save(guildId: string, name: string, tracks: SavedTrack[]): { ok: boolean; error?: string; tracks?: number } {
    const key = normalizeName(name);
    if (!key) return { ok: false, error: 'Provide a name, e.g. `V@save late-night`.' };
    if (tracks.length === 0) return { ok: false, error: 'Nothing to save — the queue is empty.' };
    const data = this.load(guildId);
    if (!data[key] && Object.keys(data).length >= MAX_PER_GUILD) {
      return { ok: false, error: `You already have ${MAX_PER_GUILD} playlists — delete one first.` };
    }
    const trimmed = tracks.slice(0, MAX_TRACKS);
    data[key] = { name: name.trim().slice(0, 60), tracks: trimmed, updatedAt: Date.now() };
    this.persist(guildId);
    return { ok: true, tracks: trimmed.length };
  }

  /** Append a track to a playlist (creating it if needed), skipping exact dupes. */
  appendTrack(guildId: string, name: string, track: SavedTrack): void {
    const key = normalizeName(name);
    const data = this.load(guildId);
    const pl = data[key] ?? (data[key] = { name: name.trim().slice(0, 60), tracks: [], updatedAt: Date.now() });
    if (pl.tracks.some((t) => t.uri === track.uri)) return;
    pl.tracks.push(track);
    if (pl.tracks.length > MAX_TRACKS) pl.tracks.splice(0, pl.tracks.length - MAX_TRACKS);
    pl.updatedAt = Date.now();
    this.persist(guildId);
  }

  delete(guildId: string, name: string): boolean {
    const key = normalizeName(name);
    const data = this.load(guildId);
    if (!data[key]) return false;
    delete data[key];
    this.persist(guildId);
    return true;
  }
}
