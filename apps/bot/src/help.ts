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
