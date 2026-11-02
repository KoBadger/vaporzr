import { describe, expect, it } from 'vitest';
import { isOfficialMusicChannel } from '../discord.js';

describe('official music channel detection', () => {
  it('accepts the artist, Topic and VEVO channels', () => {
    expect(isOfficialMusicChannel('Sublime', ['Sublime'])).toBe(true);
    expect(isOfficialMusicChannel('Sublime - Topic', ['Sublime'])).toBe(true);
    expect(isOfficialMusicChannel('SublimeVEVO', ['Sublime'])).toBe(true);
    expect(isOfficialMusicChannel('Sublime Official', ['Sublime'])).toBe(true);
    expect(isOfficialMusicChannel('The Neighbourhood - Topic', ['The Neighbourhood'])).toBe(true);
    expect(isOfficialMusicChannel('A$AP RockyVEVO', ['A$AP Rocky'])).toBe(true);
  });

  it('rejects fan uploads and background channels', () => {
    expect(isOfficialMusicChannel('SomeGuyBeats', ['Sublime'])).toBe(false);
    expect(isOfficialMusicChannel('Chill Nation', ['Sublime'])).toBe(false);
    expect(isOfficialMusicChannel('Official Sublime', ['Sublime'])).toBe(false);
    expect(isOfficialMusicChannel('', ['Sublime'])).toBe(false);
    expect(isOfficialMusicChannel('Sublime - Topic', [])).toBe(false);
  });
});
