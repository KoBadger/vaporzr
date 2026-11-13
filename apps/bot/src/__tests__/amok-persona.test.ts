import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AMOK_OFFLINE_LINES,
  AMOK_PERSONA,
  amokOfflineLine,
  amokPersona,
  consumeVoiceBudget,
  voiceBudgetRemaining,
} from '../amok.js';

// The character is a string constant now, which means it can rot silently on
// the next prompt edit. These tests pin the things that make it AMOK 9000: the
// name, the restraint, the safety floor, and the brevity rule. They deliberately
// do not assert on model output - a prompt change should fail here, not in
// production, but a creative model should never be forced into a fixture.

const ENV_KEYS = ['AMOK_TONE', 'AMOK_VOICE_DAILY_LIMIT'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('AMOK 9000 persona', () => {
  it('names the character', () => {
    expect(AMOK_PERSONA).toContain('AMOK 9000');
  });

  it('explicitly retires the surfer voice', () => {
    // The HAL switch landed while the Dialogflow agent still said "Weasel".
    // This is the guard against that drift coming back.
    expect(AMOK_PERSONA).toMatch(/never use surfer slang/i);
    expect(AMOK_PERSONA).toMatch(/never say .*buddy/i);
  });

  it('keeps the hard safety floor', () => {
    expect(AMOK_PERSONA).toMatch(/protected group/i);
    expect(AMOK_PERSONA).toMatch(/nothing sexual involving minors/i);
    expect(AMOK_PERSONA).toMatch(/no threats of violence/i);
  });

  it('keeps replies short', () => {
    expect(AMOK_PERSONA).toMatch(/under 40 words/i);
  });

  it('never allows breaking character', () => {
    expect(AMOK_PERSONA).toMatch(/never break character/i);
    expect(AMOK_PERSONA).toMatch(/never mention being an ai/i);
  });

  it('defines the queue line and says when to use it', () => {
    expect(AMOK_PERSONA).toContain('AMOK_QUEUE:');
    expect(AMOK_PERSONA).toMatch(/only when the user actually asks for music/i);
  });
});

describe('amokPersona tone knob', () => {
  it('is unchanged by default', () => {
    expect(amokPersona()).toBe(AMOK_PERSONA);
  });

  it('appends warmth when asked', () => {
    process.env.AMOK_TONE = 'warmer';
    const persona = amokPersona();
    expect(persona.startsWith(AMOK_PERSONA)).toBe(true);
    expect(persona).toMatch(/warmth/i);
  });

  it('appends restraint when asked', () => {
    process.env.AMOK_TONE = 'clinical';
    expect(amokPersona()).toMatch(/maximise restraint/i);
  });

  it('ignores unknown values so a typo cannot change the character', () => {
    process.env.AMOK_TONE = 'surfer-dude';
    expect(amokPersona()).toBe(AMOK_PERSONA);
  });

  it('leaves the NSFW floor in place regardless of tone', () => {
    process.env.AMOK_TONE = 'warmer';
    expect(amokPersona()).toMatch(/nothing sexual involving minors/i);
  });
});

describe('offline lines', () => {
  it('are all short enough to speak and to leave in a channel', () => {
    for (const line of AMOK_OFFLINE_LINES) {
      expect(line.length).toBeGreaterThan(10);
      expect(line.length).toBeLessThanOrEqual(140);
    }
  });

  it('stay in character', () => {
    for (const line of AMOK_OFFLINE_LINES) {
      expect(line).not.toMatch(/buuuddy|broham|gnarly|wheezi/i);
      expect(line).not.toMatch(/error|exception|api|provider/i);
    }
  });

  it('picks deterministically at the ends of the range', () => {
    expect(amokOfflineLine(() => 0)).toBe(AMOK_OFFLINE_LINES[0]);
    expect(amokOfflineLine(() => 0.9999)).toBe(AMOK_OFFLINE_LINES[AMOK_OFFLINE_LINES.length - 1]);
  });
});

describe('voice budget', () => {
  it('is unlimited when the limit is zero', () => {
    process.env.AMOK_VOICE_DAILY_LIMIT = '0';
    const user = 'unlimited-user';
    for (let i = 0; i < 50; i++) expect(consumeVoiceBudget(user)).toBe(true);
    expect(voiceBudgetRemaining(user)).toBe(Infinity);
  });

  it('stops spending once the daily limit is reached', () => {
    process.env.AMOK_VOICE_DAILY_LIMIT = '2';
    const user = 'capped-user';
    const now = Date.UTC(2026, 0, 5, 12);
    expect(consumeVoiceBudget(user, now)).toBe(true);
    expect(consumeVoiceBudget(user, now)).toBe(true);
    expect(consumeVoiceBudget(user, now)).toBe(false);
    expect(voiceBudgetRemaining(user, now)).toBe(0);
  });

  it('resets on the next UTC day', () => {
    process.env.AMOK_VOICE_DAILY_LIMIT = '1';
    const user = 'daily-user';
    const today = Date.UTC(2026, 0, 5, 12);
    const tomorrow = Date.UTC(2026, 0, 6, 1);
    expect(consumeVoiceBudget(user, today)).toBe(true);
    expect(consumeVoiceBudget(user, today)).toBe(false);
    expect(consumeVoiceBudget(user, tomorrow)).toBe(true);
  });

  it('does not meter anonymous callers', () => {
    process.env.AMOK_VOICE_DAILY_LIMIT = '1';
    expect(consumeVoiceBudget('')).toBe(true);
    expect(consumeVoiceBudget('')).toBe(true);
  });
});
