import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckSource } from '@vaporzr/shared';
import { DeckMixer } from '../deckMixer.js';

/**
 * A cued deck used to spawn ffmpeg anyway: it filled the ring, blocked on the
 * buffer cap, and sat there for the life of the cue with no tick running to
 * drain it. These tests pin the two halves of that fix — no decoder until the
 * deck actually plays, and a decoder that fails still ends the deck instead of
 * leaving it "playing" over an empty ring — without needing real ffmpeg.
 */

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

interface FakeProc extends EventEmitter {
  stdout: EventEmitter & { pause: () => void; resume: () => void; destroy: () => void; isPaused: () => boolean };
  stderr: EventEmitter;
  kill: () => void;
}

function fakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = Object.assign(new EventEmitter(), {
    pause: () => {},
    resume: () => {},
    destroy: () => {},
    isPaused: () => false,
  });
  proc.stderr = new EventEmitter();
  proc.kill = () => {};
  return proc;
}

const source = (over: Partial<DeckSource> = {}): DeckSource => ({
  file: 'C:/media/demo.flac',
  title: 'Demo',
  durationMs: 300_000,
  ...over,
});

/** argv of the Nth spawn call, minus the binary path. */
const spawnArgs = (n = 0): string[] => spawnMock.mock.calls[n]![1] as string[];

describe('deck cueing', () => {
  let mixer: DeckMixer;

  beforeEach(() => {
    spawnMock.mockReset();
    vi.useFakeTimers();
    mixer = new DeckMixer({ sink: () => true, ffmpegPath: 'ffmpeg' });
  });

  afterEach(() => {
    mixer.stopAll();
    vi.useRealTimers();
  });

  it('cues without spawning a decoder or starting the tick', () => {
    mixer.load('a', source(), { seekMs: 42_000 });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(mixer.isRunning()).toBe(false);
    const deck = mixer.state().a;
    expect(deck.playing).toBe(false);
    expect(deck.source?.title).toBe('Demo');
    // The cue point is kept, so play() knows where to start the decoder.
    expect(deck.positionMs).toBe(42_000);
  });

  it('keeps the cued deck decoder-free through seek and tempo changes', () => {
    mixer.load('b', source(), { seekMs: 1_000 });
    mixer.seek('b', 120_000);
    mixer.setTempo('b', 1.25);
    // Looping a cued deck also jumps the playhead — still nothing to decode.
    mixer.loopBeats('b', 4);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(mixer.state().b.playing).toBe(false);
    expect(mixer.state().b.tempo).toBeCloseTo(1.25, 6);
    expect(mixer.isRunning()).toBe(false);
  });

  it('starts one decoder at the cue point when the deck plays', () => {
    spawnMock.mockImplementation(() => fakeProc());
    mixer.load('a', source(), { seekMs: 90_000 });
    mixer.seek('a', 150_000);
    mixer.setTempo('a', 1.05);
    expect(spawnMock).not.toHaveBeenCalled();

    mixer.play('a');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnArgs();
    // Input seek so the decoder starts at the cue, not at zero.
    expect(args[args.indexOf('-ss') + 1]).toBe('150.000');
    expect(args[args.indexOf('-i') + 1]).toBe('C:/media/demo.flac');
    // atempo is chained in so the stretched deck decodes at the right rate.
    expect(args[args.indexOf('-af') + 1]).toContain('atempo=1.0500');
    expect(mixer.state().a.playing).toBe(true);
    expect(mixer.isRunning()).toBe(true);
    expect(mixer.state().a.positionMs).toBe(150_000);
  });

  it('reuses the cued position when a seek lands while playing', () => {
    spawnMock.mockImplementation(() => fakeProc());
    mixer.load('a', source(), { seekMs: 10_000, play: true });
    mixer.seek('a', 200_000);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    // The first decoder was killed, the replacement starts at the new position.
    expect(spawnArgs(1)[spawnArgs(1).indexOf('-ss') + 1]).toBe('200.000');
    // A seek is not a second playhead: still one live decoder.
    expect(mixer.state().a.playing).toBe(true);
  });

  it('ends a deck whose decoder reports an error instead of playing silence', () => {
    const proc = fakeProc();
    spawnMock.mockImplementation(() => proc);
    const ended: string[] = [];
    mixer = new DeckMixer({ sink: () => true, ffmpegPath: 'ffmpeg', onDeckEnd: (deck) => ended.push(deck) });

    mixer.load('a', source({ durationMs: 30_000 }), { play: true });
    expect(mixer.state().a.playing).toBe(true);

    // A spawn/exec failure never emits 'exit' — only 'error'.
    proc.emit('error', new Error('spawn ffmpeg ENOENT'));
    vi.advanceTimersByTime(200);

    const deck = mixer.state().a;
    expect(deck.playing).toBe(false);
    expect(deck.ended).toBe(true);
    expect(ended).toEqual(['a']);
    // Nothing left to mix, so the ticker shuts down rather than spinning.
    expect(mixer.isRunning()).toBe(false);
  });

  it('does not spawn a second decoder when play() is repeated on a live deck', () => {
    spawnMock.mockImplementation(() => fakeProc());
    mixer.load('a', source(), { play: true });
    mixer.play('a');
    mixer.play('a');

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
