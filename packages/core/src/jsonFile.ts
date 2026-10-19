import fs from 'node:fs';
import path from 'node:path';

/**
 * Write a JSON state file atomically: serialize to a sibling temp file, then
 * rename over the target. rename() is atomic on the same volume, so a crash
 * mid-write can never leave a truncated document that the next boot would fail
 * to parse (which for state files like queues, stats and tokens means silent
 * data loss).
 *
 * Mirrors apps/bot/src/jsonFile.ts; kept here so packages/core stores can use
 * the same primitive without depending on the bot app.
 */
export function writeJsonAtomicSync(file: string, data: unknown, indent: number | undefined = 2): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, indent), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}
