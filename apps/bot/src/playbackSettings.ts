import fs from 'node:fs';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
import { writeJsonAtomicSync } from './jsonFile.js';

/**
 * Where audio actually comes from.
 *
 * `SPOTIFY_PREFER_YOUTUBE=1` is the env switch, but the env belongs to the
 * deployment: changing it means a shell on the box, and a redeploy can revert a
 * hand-edited value. This keeps the choice on the data volume instead, so
 * `/source youtube` sticks, is reversible, and takes effect on the next track
 * without a restart (playback reads `config.spotifyPreferYoutube` lazily).
 */

interface PlaybackSettingsFile {
  preferYoutube?: boolean;
  updatedAt?: number;
}

function file(): string {
  return path.join(config.dataDir, 'playback-settings.json');
}

let loaded = false;

export function loadPlaybackSettings(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(file())) return;
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as PlaybackSettingsFile;
    if (typeof raw.preferYoutube === 'boolean') config.spotifyPreferYoutube = raw.preferYoutube;
  } catch (err) {
    console.warn(`[playback] could not read settings: ${err instanceof Error ? err.message : err}`);
  }
}

export function setPreferYoutube(on: boolean): void {
  loadPlaybackSettings();
  config.spotifyPreferYoutube = on;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    writeJsonAtomicSync(file(), { preferYoutube: on, updatedAt: Date.now() } satisfies PlaybackSettingsFile);
  } catch (err) {
    console.warn(`[playback] could not save settings: ${err instanceof Error ? err.message : err}`);
  }
}

export function playbackSourceStatus(): { preferYoutube: boolean; source: 'saved' | 'env' } {
  loadPlaybackSettings();
  let fromFile = false;
  try {
    if (fs.existsSync(file())) {
      const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as PlaybackSettingsFile;
      fromFile = typeof raw.preferYoutube === 'boolean';
    }
  } catch {
    /* treat as env */
  }
  return { preferYoutube: config.spotifyPreferYoutube, source: fromFile ? 'saved' : 'env' };
}
