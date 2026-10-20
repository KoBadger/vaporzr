import { describe, expect, it } from 'vitest';
import {
  amokSessionId,
  cleanWeaselSpeechText,
  extractAmokReply,
  monoWavToStereoPcm,
  parseWeaselResponse,
  resetAmokSession,
  shouldGroundOnWeb,
} from '../amok.js';
import { V_ALIASES, V_DISPATCH_ALIASES } from '../aliases.js';

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

  it('detects queries that should use live Google Search grounding', () => {
    expect(shouldGroundOnWeb('what is the weather in LA today?')).toBe(true);
    expect(shouldGroundOnWeb('who won the game last night?')).toBe(true);
    expect(shouldGroundOnWeb('latest news headlines')).toBe(true);
    expect(shouldGroundOnWeb('hey buddy how are you')).toBe(false);
  });

  it('cleans markdown and converts 48 kHz mono WAV to stereo PCM', () => {
    expect(cleanWeaselSpeechText('Hey **buuuddy**! `wheeze` https://example.com')).toBe('Hey buuuddy! wheeze');
    const wav = Buffer.alloc(44 + 4);
    wav.write('RIFF', 0, 'ascii');
    wav.writeInt16LE(1000, 44);
    wav.writeInt16LE(-1000, 46);
    const clip = monoWavToStereoPcm(wav);
    expect(clip).not.toBeNull();
    expect(clip!.pcm.length).toBe(8);
    expect(clip!.pcm.readInt16LE(0)).toBe(1000);
    expect(clip!.pcm.readInt16LE(2)).toBe(1000);
    expect(clip!.pcm.readInt16LE(4)).toBe(-1000);
    expect(clip!.pcm.readInt16LE(6)).toBe(-1000);
  });
});
