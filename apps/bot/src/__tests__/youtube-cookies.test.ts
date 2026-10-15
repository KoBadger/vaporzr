import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liveCookiesPath, syncConfiguredCookies } from '@vaporzr/core/youtube';
import { config } from '@vaporzr/core/config';

/** A complete-looking Netscape jar — the mounted export the operator drops in. */
const JAR = [
  '# Netscape HTTP Cookie File',
  '.youtube.com\tTRUE\t/\tTRUE\t1790000000\tSID\tfresh-session',
  `# Written by a browser extension`,
].join('\n');

describe('syncConfiguredCookies', () => {
  let tmp: string;
  const originalDir = config.dataDir;
  const originalPath = config.youtubeCookiesPath;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-cookies-'));
    config.dataDir = path.join(tmp, 'data');
    fs.mkdirSync(config.dataDir, { recursive: true });
  });

  afterEach(() => {
    config.dataDir = originalDir;
    config.youtubeCookiesPath = originalPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Write the mounted (configured) jar, mtime `ageMs` in the past. */
  function mount(contents: string, ageMs: number): string {
    const file = path.join(tmp, 'cookies.txt');
    fs.writeFileSync(file, contents);
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
    config.youtubeCookiesPath = file;
    return file;
  }

  /** Write the live jar in the data volume, mtime `ageMs` in the past. */
  function live(contents: string, ageMs: number): string {
    const file = liveCookiesPath();
    fs.writeFileSync(file, contents);
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
    return file;
  }

  it('replaces a staler live jar with the mounted one', () => {
    const from = mount(JAR, 0);
    const to = live('stale stripped jar\n', 60_000);

    const res = syncConfiguredCookies();

    expect(res).toMatchObject({ from, to });
    expect(fs.readFileSync(to, 'utf8')).toBe(JAR);
  });

  it('leaves a newer live jar alone so Discord uploads survive', () => {
    mount(JAR, 60_000);
    const to = live('uploaded through the bot\n', 0);

    expect(syncConfiguredCookies()).toBeNull();
    expect(fs.readFileSync(to, 'utf8')).toBe('uploaded through the bot\n');
  });

  it('is a no-op once the live jar has been refreshed', () => {
    mount(JAR, 0);
    live('stale stripped jar\n', 60_000);

    expect(syncConfiguredCookies()).not.toBeNull();
    // The copy stamps a fresh mtime, so the mount is no longer "newer".
    expect(syncConfiguredCookies()).toBeNull();
  });

  it('does nothing when the live jar does not exist yet', () => {
    mount(JAR, 0);

    expect(syncConfiguredCookies()).toBeNull();
    // The configured path is already in effect — no surprise writes.
    expect(fs.existsSync(liveCookiesPath())).toBe(false);
  });

  it('does nothing when no jar is mounted', () => {
    config.youtubeCookiesPath = '';
    live('stale stripped jar\n', 60_000);

    expect(syncConfiguredCookies()).toBeNull();
  });

  it('does nothing when the mount is the live jar (dev layout)', () => {
    const same = live(JAR, 60_000);
    config.youtubeCookiesPath = same;

    expect(syncConfiguredCookies()).toBeNull();
  });
});
