import { describe, expect, it } from 'vitest';
import { parseVoiceUtterance } from '../discord.js';

describe('voice ears: address parsing', () => {
  it('recognises the name however speech-to-text spells it', () => {
    for (const line of [
      'Yo, Amock, play some sublime.',
      'Hey AMOK, what song is this?',
      'amok skip this one',
      'Hey Hal, turn it up',
      'Hey HAL 9000, roast the queue',
      'hey amok how are you',
    ]) {
      expect(parseVoiceUtterance(line).addressed, line).toBe(true);
    }
  });

  it('strips filler and the vocative so the dispatcher sees a command', () => {
    expect(parseVoiceUtterance('Yo, Amock, play some sublime.').command).toBe('play some sublime.');
    expect(parseVoiceUtterance('Hey Hal, skip this').command).toBe('skip this');
    expect(parseVoiceUtterance('Okay so, hey AMOK, put on some Nine Inch Nails').command).toBe(
      'put on some Nine Inch Nails',
    );
    expect(parseVoiceUtterance('Hey HAL 9000, roast the queue').command).toBe('roast the queue');
  });

  it('accepts a bare imperative in a quiet voice channel', () => {
    expect(parseVoiceUtterance('play some sublime')).toEqual({ addressed: true, command: 'play some sublime' });
    expect(parseVoiceUtterance('skip this').addressed).toBe(true);
  });

  it('ignores room chatter and the model narrating itself', () => {
    expect(parseVoiceUtterance('and a glass of water, please.').addressed).toBe(false);
    expect(parseVoiceUtterance('Transcribing the audio clip.').addressed).toBe(false);
    expect(parseVoiceUtterance('Tinker 1234').addressed).toBe(false);
    expect(parseVoiceUtterance('   ').addressed).toBe(false);
  });
});
