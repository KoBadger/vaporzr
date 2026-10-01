import { describe, expect, it } from 'vitest';
import { aliasIndexFields, chunkFieldsIntoEmbeds, packCategoryFields, FIELD_MAX } from '../help.js';
import { V_ALIASES } from '../aliases.js';

describe('packCategoryFields', () => {
  it('keeps every line, splitting oversized categories into (cont.) fields', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `\`cmd${i}\` — ${'x'.repeat(60)}`);
    const fields = packCategoryFields([{ name: '🎛️ FX', lines }]);
    expect(fields.length).toBeGreaterThan(1);
    expect(fields[0].name).toBe('🎛️ FX');
    expect(fields[1].name).toContain('(cont.)');
    for (const f of fields) expect(f.value.length).toBeLessThanOrEqual(FIELD_MAX);
    const joined = fields.map((f) => f.value).join('\n');
    for (const line of lines) expect(joined).toContain(line);
  });

  it('keeps small categories as a single field', () => {
    const fields = packCategoryFields([{ name: 'Voice', lines: ['a', 'b'] }]);
    expect(fields).toEqual([{ name: 'Voice', value: 'a\nb' }]);
  });

  it('preserves category order', () => {
    const fields = packCategoryFields([
      { name: 'One', lines: ['a'] },
      { name: 'Two', lines: ['b'] },
    ]);
    expect(fields.map((f) => f.name)).toEqual(['One', 'Two']);
  });
});

describe('chunkFieldsIntoEmbeds', () => {
  it('splits fields into pages under the size budget', () => {
    const fields = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}`, value: 'y'.repeat(900) }));
    const pages = chunkFieldsIntoEmbeds(fields, 2000);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      const total = page.reduce((n, f) => n + f.name.length + f.value.length, 0);
      expect(total).toBeLessThanOrEqual(2000 + 900);
    }
    expect(pages.flat()).toHaveLength(12);
  });

  it('never returns zero pages', () => {
    expect(chunkFieldsIntoEmbeds([])).toEqual([[]]);
  });
});

describe('aliasIndexFields', () => {
  it('lists every shortcut exactly once', () => {
    const fields = aliasIndexFields(V_ALIASES);
    const text = fields.map((f) => f.value).join(' · ');
    const keys = Object.keys(V_ALIASES);
    for (const key of keys) expect(text).toContain(`\`${key}\`→`);
    expect(text.match(/`p`→/g)).toHaveLength(1);
  });

  it('keeps each field within the embed value limit', () => {
    for (const f of aliasIndexFields(V_ALIASES)) expect(f.value.length).toBeLessThanOrEqual(1024);
  });

  it('groups by first letter in the field name', () => {
    const fields = aliasIndexFields({ apple: 'x', banana: 'y', cherry: 'z' });
    expect(fields[0].name).toContain('A');
    expect(fields[0].name).toContain('C');
  });
});

describe('help coverage', () => {
  it('the new games and follow commands are documented in the help source', async () => {
    // Guards the promise that every player-facing feature is discoverable.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../discord.ts', import.meta.url), 'utf8'),
    );
    for (const cmd of ['/follow', '/stump', '/duel', '/roulette', '/wrapped', '/eq', '/norm', '/vibe']) {
      expect(src).toContain(cmd);
    }
  });
});
