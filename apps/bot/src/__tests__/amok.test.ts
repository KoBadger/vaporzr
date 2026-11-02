import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

// The Weasel's memory store persists to config.dataDir/weasel-memory.json, and
// this file writes to it. Point DATA_DIR at a throwaway directory BEFORE
// ../amok.js (and the config it imports) is evaluated — otherwise the artist
// counters accumulate across runs and the second `npm test` on one machine fails
// with "Sublime (4x)" instead of "(2x)". It passes in CI only because the
// workspace is fresh every run.
vi.hoisted(() => {
  const g = globalThis as { __amokPrevDataDir?: string };
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp';
  g.__amokPrevDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = `${base}/vaporzr-amok-test-${process.pid}`;
});

import {
  amokSessionId,
  buildWeaselSsml,
  cleanVoiceReference,
  cleanWeaselSpeechText,
  extractAmokReply,
  getWeaselMemorySummary,
  monoWavToStereoPcm,
  noteWeaselUserArtists,
  parseWavePicks,
  parseWeaselResponse,
  pcmMono48kToWav,
  rememberWeaselFact,
  resetAmokSession,
  shouldGroundOnWeb,
  softenWeaselPcm,
  splitWeaselSpeech,
} from '../amok.js';
import { V_ALIASES, V_DISPATCH_ALIASES } from '../aliases.js';

afterAll(() => {
  const g = globalThis as { __amokPrevDataDir?: string };
  const dir = process.env.DATA_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (g.__amokPrevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = g.__amokPrevDataDir;
});

describe('Amok ("The Weasel") Discord integration', () => {
  it('registers V@weasel, V@amok, V@pauly, and V@w aliases', () => {
    expect(V_ALIASES.weasel).toBe('weasel');
    expect(V_ALIASES.amok).toBe('weasel');
    expect(V_ALIASES.pauly).toBe('weasel');
    expect(V_ALIASES.w).toBe('weasel');
    expect(V_DISPATCH_ALIASES.amok).toBe('weasel');
    expect(V_DISPATCH_ALIASES.pauly).toBe('weasel');
    expect(V_DISPATCH_ALIASES.w).toBe('weasel');
  });

  it('builds stable session IDs and rotates them on reset', () => {
    const first = amokSessionId('guild-123', 'user-456');
    const same = amokSessionId('guild-123', 'user-456');
    expect(first).toBe(same);

    resetAmokSession('guild-123', 'user-456');
    const afterReset = amokSessionId('guild-123', 'user-456');
    expect(afterReset).not.toBe(first);
  });

  it('extracts and joins text chunks from Dialogflow CX detectIntent responses', () => {
    const reply = extractAmokReply({
      queryResult: {
        responseMessages: [
          { text: { text: ["Hey buuuddy! What's shakin'?"] } },
          { text: { text: ['Keep wheezin the juice!'] } },
        ],
      },
    });
    expect(reply).toBe("Hey buuuddy! What's shakin'?\n\nKeep wheezin the juice!");
  });

  it('parses WEASEL_QUEUE lines into clean display text and track queries', () => {
    const raw = [
      'Hey buuuddy! Here are three righteous skate punk tracks!',
      '',
      '`WEASEL_QUEUE: Pennywise - Bro Hymn | Bad Religion - 21st Century (Digital Boy) | NOFX - Linoleum`',
    ].join('\n');
    const parsed = parseWeaselResponse(raw);
    expect(parsed.text).toBe('Hey buuuddy! Here are three righteous skate punk tracks!');
    expect(parsed.queueQueries).toEqual([
      'Pennywise - Bro Hymn',
      'Bad Religion - 21st Century (Digital Boy)',
      'NOFX - Linoleum',
    ]);
  });

  it('parses WAVE_PICK lines for AI Deep-DNA Endless Wave crate-digging', () => {
    const raw = [
      'WAVE_PICK: Gang Starr - Mass Appeal || Produced by DJ Premier in 1994, flips a Vic Juris jazz guitar sample in the same 94 BPM G-minor pocket',
      'WAVE_PICK: Pete Rock & CL Smooth - T.R.O.Y. || Classic 90s horn-sampled boom-bap with matching harmonic warmth',
    ].join('\n');
    const picks = parseWavePicks(raw);
    expect(picks).toEqual([
      {
        query: 'Gang Starr - Mass Appeal',
        why: 'Produced by DJ Premier in 1994, flips a Vic Juris jazz guitar sample in the same 94 BPM G-minor pocket',
      },
      {
        query: 'Pete Rock & CL Smooth - T.R.O.Y.',
        why: 'Classic 90s horn-sampled boom-bap with matching harmonic warmth',
      },
    ]);
  });

  it('splits a line into speakable sentences so clones never truncate', () => {
    const chunks = splitWeaselSpeech(
      'Sup buuuddy! This is the Weasel, coming at you live. We got a long one here — really long, with a clause that keeps going and going and going past the limit so the splitter has to break it somewhere sensible.',
    );
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]).toBe('Sup buuuddy!');
    expect(chunks.every((c) => c.length <= 190)).toBe(true);
    expect(chunks.join(' ')).toContain('sensible');
  });

  it('detects queries that should use live Google Search grounding', () => {
    expect(shouldGroundOnWeb('what is the weather in LA today?')).toBe(true);
    expect(shouldGroundOnWeb('who won the game last night?')).toBe(true);
    expect(shouldGroundOnWeb('what sample did this song flip?')).toBe(true);
    expect(shouldGroundOnWeb('hey buddy how are you')).toBe(false);
  });

  it('shapes surfer SSML prosody and converts 48 kHz mono WAV/PCM buffers', () => {
    expect(cleanWeaselSpeechText('Hey **buuuddy**! `wheeze` https://example.com')).toBe('Hey buuuddy! wheeze');
    const ssml = buildWeaselSsml('Hey buuuddy! Keep wheezin the ju-uice!');
    expect(ssml).toContain('<prosody rate="84%" pitch="+0.6st">buuuddy</prosody>');
    expect(ssml).toContain('<prosody rate="84%" pitch="+0.6st">ju-uice</prosody>');

    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(1000, 0);
    pcm.writeInt16LE(-1000, 2);
    const wav = pcmMono48kToWav(pcm);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    const clip = monoWavToStereoPcm(wav);
    expect(clip).not.toBeNull();
    expect(clip!.pcm.length).toBe(8);
    expect(clip!.pcm.readInt16LE(0)).toBe(1000);
    expect(clip!.pcm.readInt16LE(2)).toBe(1000);
    expect(clip!.pcm.readInt16LE(4)).toBe(-1000);
    expect(clip!.pcm.readInt16LE(6)).toBe(-1000);
  });

  it('cleans a voice reference: trims silence and normalises the peak', () => {
    // 2 s of 48 kHz mono: 0.5 s silence, 1 s of "speech", 0.5 s silence.
    const frames = 48_000 * 2;
    const pcm = Buffer.alloc(frames * 2);
    for (let i = 48_000 * 0.5; i < 48_000 * 1.5; i++) {
      const v = Math.round(Math.sin((2 * Math.PI * 180 * i) / 48_000) * 8000);
      pcm.writeInt16LE(v, i * 2);
    }
    const out = cleanVoiceReference(pcmMono48kToWav(pcm));
    expect(out).not.toBeNull();
    // Lead-in and tail are gone: roughly one second of speech survives.
    expect(out!.durationMs).toBeGreaterThan(850);
    expect(out!.durationMs).toBeLessThan(1200);
    // Peak normalised upward (the source peaks at ~0.24).
    let peak = 0;
    for (let i = 0; i < Math.floor(out!.wav.length - 44) / 2; i++) {
      peak = Math.max(peak, Math.abs(out!.wav.readInt16LE(44 + i * 2)));
    }
    expect(peak).toBeGreaterThan(20_000);
    expect(cleanVoiceReference(Buffer.from('not a wav'))).toBeNull();
  });

  it('softens cloned PCM without changing its length', () => {
    const frames = 48_000;
    const pcm = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
      const v = Math.round(Math.sin((2 * Math.PI * 220 * i) / 48_000) * 30_000);
      pcm.writeInt16LE(v, i * 4);
      pcm.writeInt16LE(v, i * 4 + 2);
    }
    const soft = softenWeaselPcm(pcm);
    expect(soft.length).toBe(pcm.length);
    let peak = 0;
    for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(soft.readInt16LE(i * 4)));
    // Trimmed to about -3 dBFS instead of riding at full scale.
    expect(peak).toBeLessThanOrEqual(Math.round(0.72 * 32767));
    expect(peak).toBeGreaterThan(10_000);
  });

  it('stores and summarizes long-term user and server memory', () => {
    const uid = `u-test-${Date.now()}`;
    const gid = `g-test-${Date.now()}`;
    noteWeaselUserArtists(uid, 'Josh', ['Sublime', 'Sublime', 'Pennywise']);
    rememberWeaselFact(gid, uid, 'Josh', 'Loves 90s SoCal skate punk');
    const summary = getWeaselMemorySummary(gid, uid, 'Josh');
    expect(summary).toContain('Sublime (2x)');
    expect(summary).toContain('Loves 90s SoCal skate punk');
  });
});
