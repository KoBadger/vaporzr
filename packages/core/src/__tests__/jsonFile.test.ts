import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomicSync } from '../jsonFile.js';

describe('writeJsonAtomicSync', () => {
  let dir = '';
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('creates missing directories and writes pretty JSON', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaporzr-json-'));
    const file = path.join(dir, 'nested', 'deeper', 'state.json');
    writeJsonAtomicSync(file, { a: 1, b: [2, 3] });
    const raw = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(raw)).toEqual({ a: 1, b: [2, 3] });
    expect(raw).toContain('\n  "a": 1');
  });

  it('replaces an existing file and leaves no temp file behind', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaporzr-json-'));
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '{"old":true}');
    writeJsonAtomicSync(file, { new: true }, 0);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"new":true}');
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('keeps the previous contents intact when serialization fails', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaporzr-json-'));
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '{"stable":true}');
    expect(() => writeJsonAtomicSync(file, { n: BigInt(1) })).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{"stable":true}');
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });
});
