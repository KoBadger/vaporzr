import fs from 'node:fs';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
import { resetWebPlayerToken } from '@vaporzr/core/spotify';
import { writeJsonAtomicSync } from './jsonFile.js';

/**
 * Spotify web-player credentials, editable from Discord.
 *
 * `SPOTIFY_SP_DC` is the cookie a signed-in open.spotify.com tab keeps. It is
 * what lets the bot read a public playlist or album in full — through the web
 * player's own session — without spending the app's development-mode quota, so
 * a 429 window no longer stops links from resolving. Like the stem token it
 * used to be `.env`-only, which made "read playlists without the quota" a
 * server login; it lives in `data/spotify-settings.json` now and is applied to
 * `config` in place.
 *
 * Precedence: a cookie saved here wins over `SPOTIFY_SP_DC` from the env, because
 * the Discord command is the surface the operator can actually reach.
 */

interface SpotifySettingsFile {
  spDc?: string;
  updatedAt?: number;
}

function settingsPath(): string {
  return path.join(config.dataDir, 'spotify-settings.json');
}

let loaded = false;
let savedCookie = '';

/** Read the saved cookie once and apply it. Safe to call repeatedly. */
export function loadSpotifySettings(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(settingsPath())) return;
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as SpotifySettingsFile;
    const cookie = typeof raw.spDc === 'string' ? raw.spDc.trim() : '';
    if (cookie) apply(cookie);
  } catch (err) {
    console.warn(`[spotify] could not read settings: ${err instanceof Error ? err.message : err}`);
  }
}

function apply(cookie: string): void {
  savedCookie = cookie;
  config.spotifySpDc = cookie;
  // Any web-player token minted from the old cookie is now suspect.
  resetWebPlayerToken();
}

/** Last six characters, so the operator can tell one cookie from another. */
function hintFor(cookie: string): string {
  return cookie.length <= 6 ? '••••' : `••••${cookie.slice(-6)}`;
}

export interface SpotifySettingsStatus {
  /** True when the cookie is set, so full playlist reads and web search can run. */
  configured: boolean;
  /** Where the cookie came from: Discord, the deployment env, or nowhere. */
  source: 'discord' | 'env' | 'none';
  /** Masked tail of the cookie in use. */
  hint?: string;
}

export function spotifySettingsStatus(): SpotifySettingsStatus {
  loadSpotifySettings();
  const cookie = config.spotifySpDc.trim();
  if (!cookie) return { configured: false, source: 'none' };
  return {
    configured: true,
    source: savedCookie && savedCookie === cookie ? 'discord' : 'env',
    hint: hintFor(cookie),
  };
}

/**
 * Save a cookie. DevTools hands out `sp_dc=AQ…` (and sometimes a whole Cookie
 * header), so accept those forms and reject the usual wrong clipboard items
 * instead of storing something that fails silently on the next playlist.
 */
export function saveSpotifySettings(patch: { spDc?: string }): { ok: true } | { ok: false; error: string } {
  loadSpotifySettings();
  const raw = (patch.spDc ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return { ok: false, error: 'Paste the sp_dc cookie first.' };
  if (/^https?:\/\//i.test(raw)) {
    return { ok: false, error: 'That is a link. Copy the sp_dc value from DevTools → Application → Cookies.' };
  }
  // Tolerate `sp_dc=AQ…`, `Cookie: sp_dc=AQ…` and a full `a=1; sp_dc=AQ…; b=2`
  // header pasted straight out of DevTools.
  let cookie = raw;
  const named = /(?:^|[;\s])sp_dc=([^;\s]+)/i.exec(raw);
  if (named) cookie = named[1];
  cookie = cookie
    .replace(/^Cookie:\s*/i, '')
    .replace(/^sp_dc=/i, '')
    .trim();
  if (!cookie) return { ok: false, error: 'That does not contain an sp_dc value.' };
  if (/\s/.test(cookie)) {
    return { ok: false, error: 'That looks like several cookies — paste only the sp_dc value.' };
  }
  if (cookie.length < 40) {
    return { ok: false, error: 'That cookie looks truncated (sp_dc is usually 100+ characters).' };
  }
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    writeJsonAtomicSync(settingsPath(), { spDc: cookie, updatedAt: Date.now() } satisfies SpotifySettingsFile);
  } catch (err) {
    return { ok: false, error: `Could not save: ${err instanceof Error ? err.message : String(err)}` };
  }
  apply(cookie);
  console.log('[spotify] sp_dc saved — web-player reads and quota-free search are available');
  return { ok: true };
}

/** Forget the saved cookie; the env value (if any) comes back into effect. */
export function clearSpotifySettings(): void {
  loadSpotifySettings();
  try {
    fs.rmSync(settingsPath(), { force: true });
  } catch {
    /* nothing to remove */
  }
  const envCookie = (process.env.SPOTIFY_SP_DC ?? '').trim();
  apply(envCookie);
  console.log(
    `[spotify] saved cookie cleared — ${envCookie ? 'falling back to SPOTIFY_SP_DC' : 'web-player reads off'}`,
  );
}
