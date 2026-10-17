import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '@vaporzr/core/config';
import { PlaybackController } from '@vaporzr/core/playback';
import { SessionManager, type RestoredPlayingInfo } from '../session.js';

// A queue file on disk is the only input the restart-resume feature reads;
// voice and playback are exercised by the boot path in production.
describe('restart resume hook (restored mid-playback queues)', () => {
  let tmpDir: string;
  const originalDataDir = config.dataDir;
  const originalKeepPaused = config.keepPausedQueue;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaporzr-restart-test-'));
    config.dataDir = tmpDir;
    config.keepPausedQueue = false;
    // Stream prefetch resolves URLs in the background — keep it out of tests.
    vi.spyOn(PlaybackController.prototype, 'prefetchStream').mockImplementation(() => {});
  });

  afterEach(() => {
    config.dataDir = originalDataDir;
    config.keepPausedQueue = originalKeepPaused;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeQueueFile(guildId: string, playing: boolean, voiceChannelId?: string): void {
    const dir = path.join(tmpDir, 'queues');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${guildId}.json`),
      JSON.stringify({
        tracks: [
          { uri: 'spotify:track:one', name: 'One', artists: ['A'], durationMs: 1000, source: 'spotify' },
          { uri: 'spotify:track:two', name: 'Two', artists: ['B'], durationMs: 2000, source: 'spotify' },
        ],
        currentIndex: 1,
        state: { playing, positionMs: 0, durationMs: 2000 },
        playedThrough: false,
        voiceChannelId,
      }),
    );
  }

  it('fires for a queue that was mid-playback and carries the voice channel', () => {
    writeQueueFile('111', true, '222');
    const sessions = new SessionManager();
    const seen: Array<{ guildId: string; info: RestoredPlayingInfo }> = [];
    sessions.onRestoredPlaying((s, info) => seen.push({ guildId: s.guildId, info }));
    const s = sessions.get('111');
    expect(seen).toHaveLength(1);
    expect(seen[0].guildId).toBe('111');
    expect(seen[0].info.voiceChannelId).toBe('222');
    expect(seen[0].info.fileMtimeMs).toBeGreaterThan(0);
    // The cursor points at the track that was interrupted — resuming never
    // walks back through earlier tracks.
    expect(s.queue.getSnapshot().currentIndex).toBe(1);
  });

  it('fires without a voice channel when the queue file has none', () => {
    writeQueueFile('555', true);
    const sessions = new SessionManager();
    const seen: RestoredPlayingInfo[] = [];
    sessions.onRestoredPlaying((_s, info) => seen.push(info));
    sessions.get('555');
    expect(seen).toHaveLength(1);
    expect(seen[0].voiceChannelId).toBeUndefined();
  });

  it('does not fire for paused queues (they are dropped by default)', () => {
    writeQueueFile('333', false, '444');
    const sessions = new SessionManager();
    let fired = 0;
    sessions.onRestoredPlaying(() => fired++);
    const s = sessions.get('333');
    expect(fired).toBe(0);
    expect(s.queue.getSnapshot().tracks).toHaveLength(0);
  });
});
