import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

// The registry writes to config.dataDir/guild-registry.json, so point DATA_DIR
// at a throwaway directory before ../guildRegistry.js (and its config) loads.
vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp';
  process.env.DATA_DIR = `${base}/vaporzr-registry-test-${process.pid}`;
});

import { guildRegistry, noteGuildJoin, noteGuildLeave, noteGuildSeen } from '../guildRegistry.js';

afterAll(() => {
  const dir = process.env.DATA_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('guild registry', () => {
  it('records joins, re-adds and leaves without losing the first join date', () => {
    const first = noteGuildJoin({ id: 'g1', name: 'Server One', ownerId: 'o1', memberCount: 10 });
    expect(first.first).toBe(true);
    expect(first.record.joinedAt).toBeGreaterThan(0);

    const again = noteGuildJoin({ id: 'g1', name: 'Server One (renamed)', ownerId: 'o1', memberCount: 14 });
    expect(again.first).toBe(false);
    // A re-add keeps the original date — "added 3 times" is the signal.
    expect(again.record.joinedAt).toBe(first.record.joinedAt);
    expect(again.record.members).toBe(14);
    expect(again.record.name).toBe('Server One (renamed)');

    noteGuildSeen({ id: 'g2', name: 'Server Two', ownerId: 'o2', memberCount: 3 });
    noteGuildLeave('g2', 'Server Two', 3);

    const snap = guildRegistry();
    expect(snap.total).toBe(2);
    expect(snap.active).toBe(1);
    expect(snap.guilds.find((g) => g.id === 'g2')?.leftAt).toBeTruthy();
    expect(snap.events.filter((e) => e.type === 'join')).toHaveLength(1);
    expect(snap.events.filter((e) => e.type === 'leave')).toHaveLength(1);
    expect(snap.joinedLast7d).toBe(2);
    expect(snap.leftLast7d).toBe(1);
  });
});
