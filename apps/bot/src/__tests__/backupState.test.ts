import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKUP_STALE_HOURS, publicBackupStatus, readBackupStatus } from '../backupState.js';

const dirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vzr-backup-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('readBackupStatus', () => {
  it('reports stale when no backup marker exists at all', () => {
    // This is exactly the state that went unnoticed for five weeks: no artifact,
    // no error, no signal anywhere.
    const status = readBackupStatus(dataDir(), Date.now());
    expect(status.lastBackupAt).toBeNull();
    expect(status.ageHours).toBeNull();
    expect(status.stale).toBe(true);
    expect(status.error).toBeNull();
  });

  it('computes age and marks a recent snapshot fresh', () => {
    const dir = dataDir();
    const at = Date.UTC(2026, 10, 17, 4, 0, 0);
    writeFileSync(
      path.join(dir, 'backup-state.json'),
      JSON.stringify({ at, target: 's3:https://example.r2.cloudflarestorage.com/vzr' }),
    );

    const status = readBackupStatus(dir, at + 3 * 3_600_000);
    expect(status.lastBackupAt).toBe('2026-11-17T04:00:00.000Z');
    expect(status.ageHours).toBe(3);
    expect(status.target).toBe('s3:https://example.r2.cloudflarestorage.com/vzr');
    expect(status.stale).toBe(false);
  });

  it('marks a snapshot older than the threshold stale', () => {
    const dir = dataDir();
    const at = Date.UTC(2026, 10, 1);
    writeFileSync(path.join(dir, 'backup-state.json'), JSON.stringify({ at }));

    const status = readBackupStatus(dir, at + (BACKUP_STALE_HOURS + 1) * 3_600_000);
    expect(status.stale).toBe(true);
  });

  it('surfaces the last failure without discarding the last success', () => {
    const dir = dataDir();
    const at = Date.UTC(2026, 10, 17, 4, 0, 0);
    writeFileSync(path.join(dir, 'backup-state.json'), JSON.stringify({ at }));
    writeFileSync(path.join(dir, 'backup-last-error.txt'), 'restic: repository is full\n');

    const status = readBackupStatus(dir, at + 3_600_000);
    expect(status.error).toBe('restic: repository is full');
    expect(status.ageHours).toBe(1);
  });

  it('ignores a corrupt marker instead of throwing on /health', () => {
    const dir = dataDir();
    writeFileSync(path.join(dir, 'backup-state.json'), '{not json');
    const status = readBackupStatus(dir, Date.now());
    expect(status.ageHours).toBeNull();
    expect(status.stale).toBe(true);
  });

  it('treats a non-positive timestamp as "never ran"', () => {
    const dir = dataDir();
    writeFileSync(path.join(dir, 'backup-state.json'), JSON.stringify({ at: 0 }));
    expect(readBackupStatus(dir, Date.now()).lastBackupAt).toBeNull();
  });

  it('keeps the bucket URL out of the public /health payload', () => {
    // /health is open to the internet; the repository URL names the account and
    // bucket, so only freshness and the last error are published.
    const dir = dataDir();
    const at = Date.UTC(2026, 10, 17, 4, 0, 0);
    writeFileSync(
      path.join(dir, 'backup-state.json'),
      JSON.stringify({ at, target: 's3:https://abc123.r2.cloudflarestorage.com/vzr-data' }),
    );

    const pub = publicBackupStatus(dir, at + 3_600_000);
    expect('target' in pub).toBe(false);
    expect(pub.ageHours).toBe(1);
    expect(pub.stale).toBe(false);
  });
});
