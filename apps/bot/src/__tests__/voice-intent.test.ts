import { describe, expect, it } from 'vitest';
import { parseVoiceUtterance } from '../discord.js';

describe('voice ears: address parsing', () => {
  it('recognises the name however speech-to-text spells it', () => {
    for (const line of [
      'Yo, Wizel, play some sublime.',
      'Hey Weasel, what song is this?',
      'weezel skip this one',
      'Hey Wisel, turn it up',
      'Paulie, roast the queue',
      'hey buddy how are you',
    ]) {
      expect(parseVoiceUtterance(line).addressed, line).toBe(true);
    }
  });

  it('strips filler and the vocative so the dispatcher sees a command', () => {
    expect(parseVoiceUtterance('Yo, Wizel, play some sublime.').command).toBe('play some sublime.');
    expect(parseVoiceUtterance('Hey Pauly, skip this').command).toBe('skip this');
    expect(parseVoiceUtterance('Okay so, hey Weasel, put on some Nine Inch Nails').command).toBe(
      'put on some Nine Inch Nails',
    );
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
