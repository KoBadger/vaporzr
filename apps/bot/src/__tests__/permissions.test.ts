import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PermissionsManager } from '../permissions.js';
import { config } from '../config.js';

describe('PermissionsManager guild settings', () => {
  let tmp: string;
  const original = config.dataDir;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-perms-'));
    config.dataDir = tmp;
  });

  afterEach(() => {
    config.dataDir = original;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('defaults to voteSkip on, duckMode off, tts off', () => {
    const p = new PermissionsManager();
    expect(p.getVoteSkip('g')).toBe(true);
    expect(p.getDuckMode('g')).toBe('off');
    expect(p.getTts('g')).toBe(false);
  });

  it('persists voteSkip / duckMode / tts across instances', () => {
    const a = new PermissionsManager();
    a.setVoteSkip('g', false);
    a.setDuckMode('g', 'hosts');
    a.setTts('g', true);

    const b = new PermissionsManager();
    expect(b.getVoteSkip('g')).toBe(false);
    expect(b.getDuckMode('g')).toBe('hosts');
    expect(b.getTts('g')).toBe(true);
    expect(b.snapshot('g')).toMatchObject({ voteSkip: false, duckMode: 'hosts', tts: true });
  });

  it('keeps settings isolated per guild', () => {
    const p = new PermissionsManager();
    p.setTts('g1', true);
    p.setDuckMode('g1', 'auto');
    expect(p.getTts('g2')).toBe(false);
    expect(p.getDuckMode('g2')).toBe('off');
  });
});
