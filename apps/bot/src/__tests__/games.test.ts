import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GamesStore, describeFit, explainFit, fitPercent, keyToQuery, pickRoulette, pickRouletteWeighted } from '@vaporzr/core/games';
import { config } from '@vaporzr/core/config';

describe('game scoring helpers', () => {
  it('fitPercent turns EW\'s "lower is better" score into 5..99', () => {
    expect(fitPercent(0)).toBe(99);
    expect(fitPercent(30)).toBe(70);
    expect(fitPercent(100)).toBe(5);
    expect(fitPercent(500)).toBe(5);
    expect(fitPercent(-20)).toBe(99);
    expect(fitPercent(Number.NaN)).toBe(50);
  });

  it('describeFit scales with the number', () => {
    expect(describeFit(95)).toContain('perfect fit');
    expect(describeFit(75)).toContain('lane');
    expect(describeFit(60)).toContain('adjacent');
    expect(describeFit(45)).toContain('stretch');
    expect(describeFit(10)).toContain('curveball');
  });
});

describe('pickRoulette', () => {
  it('never picks a banned or already-queued track', () => {
    const keys = ['a', 'b', 'c', 'd'];
    for (let i = 0; i < 20; i++) {
      const pick = pickRoulette(keys, ['a'], ['b'], () => i / 20);
      expect(pick === 'a' || pick === 'b').toBe(false);
      expect(pick === 'c' || pick === 'd').toBe(true);
    }
  });

  it('returns null when nothing qualifies', () => {
    expect(pickRoulette(['a'], ['a'], [])).toBeNull();
    expect(pickRoulette([], [], [])).toBeNull();
  });

  it('uses the injected rng deterministically', () => {
    expect(pickRoulette(['x', 'y', 'z'], [], [], () => 0)).toBe('x');
    expect(pickRoulette(['x', 'y', 'z'], [], [], () => 0.99)).toBe('z');
  });

  it('keyToQuery turns "title | artist" into a search string', () => {
    expect(keyToQuery('kerala | bonobo')).toBe('kerala bonobo');
    expect(keyToQuery('no artist')).toBe('no artist');
  });
});

describe('GamesStore', () => {
  let tmp: string;
  const original = config.dataDir;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-games-'));
    config.dataDir = tmp;
  });

  afterEach(() => {
    config.dataDir = original;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('tracks stump wins, bot wins and duel wins', () => {
    const g = new GamesStore();
    expect(g.addStumpWin('g1', 'alice')).toBe(1);
    expect(g.addStumpWin('g1', 'alice')).toBe(2);
    expect(g.addBotWin('g1')).toBe(1);
    expect(g.addDuelWin('g1', 'bob')).toBe(1);
    expect(g.get('g1').stumpWins.alice).toBe(2);
    expect(g.get('g1').botWins).toBe(1);
  });

  it('is isolated per guild', () => {
    const g = new GamesStore();
    g.addBotWin('g1');
    expect(g.get('g1').botWins).toBe(1);
    expect(g.get('g2').botWins).toBe(0);
  });

  it('bans a key only once and reports it', () => {
    const g = new GamesStore();
    expect(g.isBanned('g1', 'kerala | bonobo')).toBe(false);
    g.ban('g1', 'kerala | bonobo');
    g.ban('g1', 'kerala | bonobo');
    expect(g.isBanned('g1', 'kerala | bonobo')).toBe(true);
    expect(g.get('g1').banned).toHaveLength(1);
  });

  it('persists to disk and reloads', () => {
    const g = new GamesStore();
    g.addDuelWin('g1', 'zoe');
    g.ban('g1', 'x | y');
    // Force the debounced save by waiting on the timer.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const again = new GamesStore();
        expect(again.get('g1').duelWins.zoe).toBe(1);
        expect(again.isBanned('g1', 'x | y')).toBe(true);
        resolve();
      }, 2100);
    });
  });

  it('star ranks the leaderboard', () => {
    const g = new GamesStore();
    g.star('g1', 'a');
    g.star('g1', 'a');
    g.star('g1', 'b');
    expect(g.topOf(g.get('g1').starred)).toEqual([['a', 2], ['b', 1]]);
  });

  it('tracks duel model accuracy', () => {
    const g = new GamesStore();
    expect(g.noteDuelOutcome('g1', true)).toEqual({ correct: 1, total: 1 });
    expect(g.noteDuelOutcome('g1', false)).toEqual({ correct: 1, total: 2 });
    expect(g.get('g1').duelAccuracy.correct).toBe(1);
  });
});

describe('explainFit', () => {
  it('reports the biggest influences first and skips noise', () => {
    const reasons = explainFit([
      { id: 'features', label: 'matches the energy', points: -19 },
      { id: 'artist', label: 'that artist just played', points: 20 },
      { id: 'duration', label: 'normal length', points: -5 },
      { id: 'source', label: 'spotify', points: -2 },
      { id: 'jitter', label: 'tiebreaker', points: 1 },
    ]);
    expect(reasons[0]).toContain('that artist just played');
    expect(reasons[1]).toContain('matches the energy');
    expect(reasons.join(' ')).not.toContain('tiebreaker');
    expect(reasons.join(' ')).not.toContain('spotify');
    expect(reasons).toHaveLength(3);
  });

  it('marks helpful terms with a tick and harmful ones with a warning', () => {
    const good = explainFit([{ id: 'features', label: 'matches the feel', points: -30 }]);
    const bad = explainFit([{ id: 'features', label: 'miles off the feel', points: 30 }]);
    expect(good[0].startsWith('✅')).toBe(true);
    expect(bad[0].startsWith('⚠️')).toBe(true);
  });

  it('returns nothing when every influence is small', () => {
    expect(explainFit([{ id: 'source', label: 'spotify', points: -2 }])).toEqual([]);
  });
});

describe('pickRouletteWeighted (deep cuts)', () => {
  it('favours rarely-played tracks over heavily-played ones', () => {
    const entries: Array<[string, number]> = [['hit', 100], ['deep', 1]];
    // Weights are 0.01 vs 1.0, so anything above ~1% of the roll range lands on
    // the deep cut.
    expect(pickRouletteWeighted(entries, [], [], () => 0.5)).toBe('deep');
    expect(pickRouletteWeighted(entries, [], [], () => 0.001)).toBe('hit');
  });

  it('still excludes banned and queued tracks', () => {
    const entries: Array<[string, number]> = [['a', 1], ['b', 1], ['c', 1]];
    for (let i = 0; i < 10; i++) {
      const pick = pickRouletteWeighted(entries, ['a'], ['b'], () => i / 10);
      expect(pick).toBe('c');
    }
  });

  it('returns null when the pool is empty', () => {
    expect(pickRouletteWeighted([], [], [])).toBeNull();
    expect(pickRouletteWeighted([['a', 1]], ['a'], [])).toBeNull();
  });
});
