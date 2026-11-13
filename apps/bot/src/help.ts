/**
 * Help rendering helpers — kept pure so the "see everything" views stay
 * testable and can never silently drop a line.
 */

export interface HelpField {
  name: string;
  value: string;
  inline?: boolean;
}

/** Discord's hard limits. */
export const FIELD_MAX = 1024;
export const EMBED_TOTAL_MAX = 6000;

/**
 * Turn categories of help lines into embed fields, splitting a category whose
 * lines exceed `maxChars` into numbered continuation fields. Every line is
 * preserved — no truncation — so `V@help all` is a complete reference.
 */
export function packCategoryFields(
  categories: Array<{ name: string; lines: string[] }>,
  maxChars = FIELD_MAX,
): HelpField[] {
  const fields: HelpField[] = [];
  for (const cat of categories) {
    let chunk: string[] = [];
    let len = 0;
    const flush = (cont: boolean) => {
      if (chunk.length === 0) return;
      fields.push({
        name: cont ? `${cat.name} (cont.)`.slice(0, 256) : cat.name.slice(0, 256),
        value: chunk.join('\n').slice(0, maxChars),
      });
      chunk = [];
      len = 0;
    };
    for (const line of cat.lines) {
      const add = line.length + 1;
      if (len + add > maxChars) flush(fields.some((f) => f.name.startsWith(cat.name)));
      chunk.push(line);
      len += add;
    }
    flush(fields.some((f) => f.name.startsWith(cat.name)));
  }
  return fields;
}

/**
 * How many messages an "all commands" reply needs: Discord caps a message at 10
 * embeds and ~6000 characters of embed content, so we split into pages.
 */
export function chunkFieldsIntoEmbeds(fields: HelpField[], maxPerEmbed = 5000): HelpField[][] {
  const pages: HelpField[][] = [];
  let page: HelpField[] = [];
  let len = 0;
  for (const f of fields) {
    const add = f.name.length + f.value.length;
    if (page.length > 0 && (len + add > maxPerEmbed || page.length >= 20)) {
      pages.push(page);
      page = [];
      len = 0;
    }
    page.push(f);
    len += add;
  }
  if (page.length > 0) pages.push(page);
  return pages.length > 0 ? pages : [[]];
}

/**
 * Compact "V@ shortcut → /command" index grouped by first letter.
 * `aliases` values are the canonical command names the shortcuts dispatch to.
 */
export function aliasIndexFields(aliases: Record<string, string>, perGroup = 1000): HelpField[] {
  const groups = new Map<string, string[]>();
  for (const [key, target] of Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b))) {
    const letter = (/^[a-z]/.test(key) ? key[0] : '#').toUpperCase();
    const bucket = groups.get(letter) ?? [];
    bucket.push(`\`${key}\`→${target}`);
    groups.set(letter, bucket);
  }
  const fields: HelpField[] = [];
  let name = '';
  let chunk: string[] = [];
  let len = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    fields.push({ name: name || 'Shortcuts', value: chunk.join(' · ').slice(0, 1024) });
    chunk = [];
    len = 0;
    name = '';
  };
  const letters = [...groups.keys()].sort();
  for (const letter of letters) {
    const text = groups.get(letter)!.join(' · ');
    if (len + text.length + 3 > perGroup) flush();
    name = name ? `${name},${letter}` : letter;
    chunk.push(text);
    len += text.length + 3;
  }
  flush();
  return fields.length > 0 ? fields : [{ name: 'Shortcuts', value: 'none' }];
}

/**
 * One searchable help line, normalised out of a category's display text.
 *
 * Categories store prose with inline `code spans`, which is right for reading
 * and wrong for searching. Rather than keep a second hand-maintained index that
 * drifts, the search parses the same lines the menu renders.
 */
export interface HelpSearchInput {
  id: string;
  emoji: string;
  name: string;
  blurb: string;
  lines: string[];
}

export interface HelpSuggestion {
  /** Category this came from, shown next to the result. */
  category: string;
  emoji: string;
  /** Command spellings, e.g. "`/play` `V@p`". Empty for a whole-category hit. */
  commands: string;
  /** Human description with the code spans removed. */
  detail: string;
  score: number;
}

const SEARCH_STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'for',
  'how',
  'do',
  'does',
  'i',
  'my',
  'me',
  'of',
  'and',
  'or',
  'with',
  'in',
  'on',
  'it',
  'is',
  'are',
  'can',
  'you',
  'your',
  'vaporzr',
  'bot',
  'command',
  'commands',
  'please',
  'help',
  'that',
  'this',
  'what',
  'where',
  'when',
]);

function normalizeForSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split one rendered help line into its commands and its description. */
export function parseHelpLine(line: string): { commands: string[]; detail: string } | null {
  const commands: string[] = [];
  const codeRe = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = codeRe.exec(line)) !== null) commands.push(match[1]!.trim());
  // Headings like **Sound** carry no commands and are not searchable entries.
  if (commands.length === 0) return null;
  const detail = line
    .replace(/`[^`]*`/g, '')
    .replace(/[*_~]/g, '')
    .replace(/^\s*[—–\-·:]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { commands, detail };
}

/**
 * Rank help entries against what somebody typed.
 *
 * Returns between `min` and `max` suggestions: a search that matched one thing
 * still offers nearby categories, because "nothing else found" is less useful
 * than "here are the areas closest to that". It never returns the whole menu —
 * the point is to shrink a ninety-command list to something readable.
 */
export function searchHelp(categories: HelpSearchInput[], query: string, min = 3, max = 10): HelpSuggestion[] {
  const raw = query.trim();
  if (!raw) return [];
  const q = normalizeForSearch(raw);
  if (!q) return [];
  const words = q.split(' ').filter((w) => w.length > 1 && !SEARCH_STOP_WORDS.has(w));
  const wantsCommand = raw.startsWith('/') || raw.startsWith('v@') || raw.startsWith('!');

  const scored: HelpSuggestion[] = [];
  const seen = new Set<string>();

  for (const cat of categories) {
    const catText = normalizeForSearch(`${cat.name} ${cat.blurb} ${cat.id}`);
    let catScore = 0;
    if (catText.includes(q)) catScore += 20;
    for (const w of words) if (catText.includes(w)) catScore += 6;

    for (const line of cat.lines) {
      const parsed = parseHelpLine(line);
      if (!parsed) continue;
      const cmdText = normalizeForSearch(parsed.commands.join(' '));
      const detailText = normalizeForSearch(parsed.detail);

      let score = 0;
      if (`${cmdText} ${detailText}`.includes(q)) score += 60;
      if (wantsCommand && parsed.commands.some((c) => normalizeForSearch(c).startsWith(q))) score += 50;
      for (const w of words) {
        // A word inside the command is a stronger signal than one buried in the
        // prose: searching "tape" should surface `/tape` before a line that
        // merely mentions keeping a tape.
        if (cmdText.includes(w)) score += 25;
        else if (detailText.includes(w)) score += 12;
      }
      if (score === 0) continue;
      score += catScore;

      const key = `${parsed.commands.join('|')}::${parsed.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      scored.push({
        category: cat.name,
        emoji: cat.emoji,
        commands: parsed.commands.map((c) => `\`${c}\``).join(' '),
        detail: parsed.detail,
        score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.detail.localeCompare(b.detail));
  const results = scored.slice(0, max);

  // Pad with the nearest categories so an answer is never one lonely hit.
  if (results.length < min) {
    const usedCats = new Set(results.map((r) => r.category));
    for (const cat of categories) {
      if (results.length >= min) break;
      if (usedCats.has(cat.name)) continue;
      usedCats.add(cat.name);
      results.push({
        category: cat.name,
        emoji: cat.emoji,
        commands: '',
        detail: `${cat.name} — ${cat.blurb}`,
        score: 0,
      });
    }
  }

  return results.slice(0, Math.max(min, Math.min(max, results.length)));
}
