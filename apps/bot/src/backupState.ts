/**
 * Freshness of the off-site backup, read from the marker a nightly job drops
 * into the data volume.
 *
 * Exists because the previous backup path failed silently for five weeks: the
 * weekly GitHub workflow never got past its SSH step, no artifact was produced,
 * and nothing in `/health` or the panel said so. A backup that cannot be seen
 * from outside is a backup nobody checks, so `/health` now reports the age of
 * the last successful off-site snapshot and any error from the last attempt.
 *
 * The job writes two sibling files in the data dir (see deploy/backup-offsite.sh):
 *   backup-state.json      success only — `{"at": <epoch ms>, "target": "..."}`. Never
 *                          overwritten by a failure, so the age keeps growing when
 *                          the remote stops working.
 *   backup-last-error.txt  the last failure, deleted by the next success.
 *
 * Pure apart from the two reads, so it is cheap to call on every health probe.
 */
import fs from 'node:fs';
import path from 'node:path';

/** A backup older than this is reported as stale. Nightly runs leave plenty of headroom. */
export const BACKUP_STALE_HOURS = 48;

/** Longest error string surfaced on the open endpoint. */
const ERROR_MAX_CHARS = 240;

export interface BackupStatus {
  /** ISO timestamp of the last successful off-site snapshot, or null if none ever ran. */
  lastBackupAt: string | null;
  /** Hours since that snapshot, one decimal. Null when there is none. */
  ageHours: number | null;
  /** Destination as recorded by the job (a repository URL; never a credential). */
  target: string | null;
  /** Message from the most recent failed run, if it has not since succeeded. */
  error: string | null;
  /** True when no snapshot exists, or the newest one is older than BACKUP_STALE_HOURS. */
  stale: boolean;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function readBackupStatus(dataDir: string, now: number = Date.now()): BackupStatus {
  const empty: BackupStatus = {
    lastBackupAt: null,
    ageHours: null,
    target: null,
    error: null,
    stale: true,
  };

  // A failure marker stands on its own: it must be visible even when the last
  // success is recent (a run that failed tonight still needs attention).
  const errorRaw = readText(path.join(dataDir, 'backup-last-error.txt'));
  const error = errorRaw ? errorRaw.trim().slice(0, ERROR_MAX_CHARS) || null : null;

  const raw = readText(path.join(dataDir, 'backup-state.json'));
  if (!raw) return { ...empty, error };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...empty, error };
  }
  if (!parsed || typeof parsed !== 'object') return { ...empty, error };

  const record = parsed as Record<string, unknown>;
  const at = Number(record.at);
  if (!Number.isFinite(at) || at <= 0) return { ...empty, error };

  const ageHours = Math.max(0, (now - at) / 3_600_000);
  const target = typeof record.target === 'string' && record.target ? record.target : null;

  return {
    lastBackupAt: new Date(at).toISOString(),
    ageHours: Math.round(ageHours * 10) / 10,
    target,
    error,
    stale: ageHours > BACKUP_STALE_HOURS,
  };
}

/**
 * The subset safe to publish on `/health`, which is open to the internet.
 *
 * The repository URL carries the storage account id and bucket name. Neither is
 * a credential, but `/health` already leaks enough internals (see the parked
 * note on trimming it), so the destination stays out of the public payload and
 * `restic snapshots` on the host remains the place to check it.
 */
export function publicBackupStatus(dataDir: string, now: number = Date.now()): Omit<BackupStatus, 'target'> {
  const { lastBackupAt, ageHours, stale, error } = readBackupStatus(dataDir, now);
  return { lastBackupAt, ageHours, stale, error };
}
