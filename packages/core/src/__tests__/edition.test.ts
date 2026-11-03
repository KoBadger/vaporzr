import { describe, expect, it } from 'vitest';
import { editionBadge, editionKind } from '@vaporzr/core/edition';

describe('editionKind', () => {
  it('returns null for a plain studio title', () => {
    expect(editionKind('Feel Good Inc.')).toBeNull();
    expect(editionKind('Liquid Game')).toBeNull();
  });

  it('flags live and concert performances', () => {
    expect(editionKind('Feel Good Inc. (Live at Coachella)')).toBe('live');
    expect(editionKind('Age Of Love (Live at Tomorrowland)')).toBe('live');
    expect(editionKind('Song - Live Concert')).toBe('live');
    expect(editionKind('Tiny Desk Concert')).toBe('live');
  });

  it('flags acoustic and unplugged takes as acoustic', () => {
    expect(editionKind('Feel Good Inc. - Acoustic')).toBe('acoustic');
    expect(editionKind('Nirvana - MTV Unplugged')).toBe('acoustic');
  });

  it('flags remastered editions last', () => {
    expect(editionKind('Abbey Road (Remastered)')).toBe('remastered');
    expect(editionKind('Thriller - 2008 Digital Remaster')).toBe('remastered');
  });

  it('does not misread the word live inside another word', () => {
    expect(editionKind('Olive Branch')).toBeNull();
    expect(editionKind('Deliverance')).toBeNull();
  });

  it('tolerates an empty or missing title', () => {
    expect(editionKind('')).toBeNull();
    expect(editionKind(undefined as unknown as string)).toBeNull();
  });
});

describe('editionBadge', () => {
  it('maps each kind to a labelled emoji and null to null', () => {
    expect(editionBadge('X (Live)')).toBe('🎤 Live');
    expect(editionBadge('X - Acoustic')).toBe('🎸 Acoustic');
    expect(editionBadge('X (Remastered)')).toBe('✨ Remastered');
    expect(editionBadge('X')).toBeNull();
  });
});
