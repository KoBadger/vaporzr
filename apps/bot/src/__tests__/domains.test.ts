import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DomainStore, normalizeDomain } from '@vaporzr/core/domains';
import { config } from '@vaporzr/core/config';

describe('normalizeDomain', () => {
  it('accepts bare hosts and https URLs', () => {
    expect(normalizeDomain('Music.Example.com')).toBe('music.example.com');
    expect(normalizeDomain('https://music.example.com/')).toBe('music.example.com');
  });

  it('rejects ports, paths, wildcards and private names', () => {
    expect(normalizeDomain('music.example.com:8443')).toBeNull();
    expect(normalizeDomain('https://music.example.com/panel')).toBeNull();
    expect(normalizeDomain('*.example.com')).toBeNull();
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('127.0.0.1')).toBeNull();
    expect(normalizeDomain('music.local')).toBeNull();
  });
});

describe('DomainStore', () => {
  let tmp: string;
  const original = config.dataDir;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-domains-'));
    config.dataDir = tmp;
  });

  afterEach(() => {
    config.dataDir = original;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('claims a host, resolves it back to the guild and persists', () => {
    const store = new DomainStore();
    expect(store.set('g1', 'music.example.com')).toEqual({ host: 'music.example.com' });
    expect(store.hostFor('g1')).toBe('music.example.com');
    expect(store.baseFor('g1')).toBe('https://music.example.com');
    expect(store.guildForHost('music.example.com')).toBe('g1');

    const again = new DomainStore();
    expect(again.guildForHost('music.example.com')).toBe('g1');
  });

  it('refuses a host already claimed by another guild', () => {
    const store = new DomainStore();
    store.set('g1', 'music.example.com');
    const result = store.set('g2', 'music.example.com');
    expect('error' in result).toBe(true);
    expect(store.hostFor('g2')).toBeNull();
  });

  it('replaces and clears a guild host', () => {
    const store = new DomainStore();
    store.set('g1', 'one.example.com');
    store.set('g1', 'two.example.com');
    expect(store.hostFor('g1')).toBe('two.example.com');
    expect(store.guildForHost('one.example.com')).toBeNull();
    expect(store.clear('g1')).toBe(true);
    expect(store.hostFor('g1')).toBeNull();
  });
});
