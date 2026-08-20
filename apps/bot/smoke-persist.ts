import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = mkdtempSync(path.join(os.tmpdir(), 'vaporzr-persist-'));
process.env.DATA_DIR = temp;

let failed = 0;
function check(cond: boolean, label: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  if (!cond) failed++;
}

const { SessionManager } = await import('./src/session.js');

const track = (uri: string, name: string) => ({
  uri,
  name,
  artists: ['Test'],
  album: 'Smoke',
  durationMs: 120_000,
  source: 'youtube' as const,
});

// 1. Build a queue in a real SessionManager, then persist (debounced).
const mgr = new SessionManager();
mgr.attachLibrespot(null);
const s = mgr.get('guild1');
s.queue.enqueue(track('youtube:video:aaa', 'Track A'), 'user1');
s.queue.enqueue(track('youtube:video:bbb', 'Track B'), 'user1');
s.queue.next();
s.queue.setState({ playing: true, positionMs: 42_000, volume: 71, shuffle: true });

check(s.queue.totalEnqueued === 2, `totalEnqueued counts queue adds (got ${s.queue.totalEnqueued})`);

await new Promise((r) => setTimeout(r, 4000));
const files = readdirSync(path.join(temp, 'queues'));
check(files.includes('guild1.json'), 'queue file written to dataDir/queues');
check(files.length === 1, 'exactly one guild file');

// 2. Simulate a restart: a fresh manager must restore it paused, mid-position.
const mgr2 = new SessionManager();
mgr2.attachLibrespot(null);
const s2 = mgr2.get('guild1');
const snap = s2.queue.getSnapshot();
check(snap.tracks.length === 2, `restored 2 tracks (got ${snap.tracks.length})`);
check(snap.tracks[0].uri === 'youtube:video:aaa' && snap.tracks[1].uri === 'youtube:video:bbb', 'track order preserved');
check(snap.currentIndex === 1, `currentIndex preserved (got ${snap.currentIndex})`);
check(snap.state.playing === false, 'starts paused (no auto-resume)');
check(snap.state.positionMs === 42_000, `position preserved (got ${snap.state.positionMs})`);
check(snap.state.volume === 71, `volume preserved (got ${snap.state.volume})`);
check(snap.state.shuffle === true, 'shuffle preserved');
check(snap.state.track?.uri === 'youtube:video:bbb', 'now-playing points at current track');

// 3. Clearing the queue should remove the persisted file.
const s3 = mgr2.get('guild2');
s3.queue.enqueue(track('youtube:video:ccc', 'Track C'), 'user1');
await new Promise((r) => setTimeout(r, 4000));
s3.queue.clear();
await new Promise((r) => setTimeout(r, 4000));
check(existsSync(path.join(temp, 'queues', 'guild2.json')) === false, 'clearing a queue removes its persisted file');

rmSync(temp, { recursive: true, force: true });
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
