#!/usr/bin/env bash
# Nightly Vaporzr data backup.
#
# Backs up everything that cannot be rebuilt: queues, tokens, keys, decks,
# samples, uploads, stats, presets, Suno tracks and the separated stems that were
# paid for. Skips only the rebuildable caches (go-librespot, video-cache, hf).
#
# The exclusion list lives in deploy/backup-excludes.txt so deploy/restore-drill.sh
# reads the same file. When the two lists drifted, `decks/` — every server's
# custom decks — was silently missing from every backup.
#
# Three layers, in order of what actually saves you:
#   1. off-site push  — deploy/backup-offsite.sh (restic → S3) or
#                       deploy/backup-github.sh (encrypted asset on a release)
#   2. local archive  — below, same disk, fast restore, NOT a backup on its own
#   3. heartbeat      — BACKUP_HEALTHCHECK_URL pinged on success (/fail on error)
#
# Install on the VPS:
#   install -m 755 deploy/backup.sh            /opt/vaporzr/backup.sh
#   install -m 644 deploy/backup-excludes.txt  /opt/vaporzr/backup-excludes.txt
#   install -m 755 deploy/backup-offsite.sh    /opt/vaporzr/backup-offsite.sh   # optional
#   install -m 755 deploy/backup-github.sh     /opt/vaporzr/backup-github.sh    # optional
#   install -m 600 deploy/backup.env.example   /etc/vaporzr/backup.env
#   (crontab -l; echo "0 4 * * * /opt/vaporzr/backup.sh >> /var/log/vaporzr-backup.log 2>&1") | crontab -
set -euo pipefail

DATA=/var/lib/docker/volumes/vaporzr-data/_data
OUT=/opt/backups
ENV_FILE=/etc/vaporzr/backup.env
EXCLUDES=${BACKUP_EXCLUDES_FILE:-/opt/vaporzr/backup-excludes.txt}
STATE="$DATA/backup-state.json"
ERRFILE="$DATA/backup-last-error.txt"
# Four archives, not seven: stems are included now, which roughly doubles each
# one. The off-site copy (six assets) is the one that survives the host anyway.
KEEP=4
STAMP=$(date +%Y%m%d-%H%M)

if [ ! -d "$DATA" ]; then
  echo "!! data volume not found at $DATA" >&2
  exit 1
fi
mkdir -p "$OUT"

# Refuse to run with a missing exclusion list rather than silently archiving the
# 2.8 GB of caches it names — an archive big enough to fill the disk on rotation.
if [ ! -f "$EXCLUDES" ]; then
  echo "!! exclusion list not found: $EXCLUDES" >&2
  echo "   install deploy/backup-excludes.txt next to this script" >&2
  exit 1
fi

# Configuration lives in one file so the local archive, both off-site targets
# and the heartbeat all read the same values.
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a
  . "$ENV_FILE"
  set +a
fi

# A run that fails must leave a visible marker AND tell an outside service. The
# old scheme had neither: five weeks of failures looked exactly like success.
on_error() {
  local code=$?
  trap - ERR
  echo "!! backup failed (exit $code)" >&2
  printf '%s backup.sh exited %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" > "$ERRFILE"
  if [ -n "${BACKUP_HEALTHCHECK_URL:-}" ]; then
    # healthchecks.io treats <url>/fail as a failure signal, which starts its
    # grace timer instead of waiting for the next missed ping.
    curl -fsS -m 10 --retry 2 "${BACKUP_HEALTHCHECK_URL%/}/fail" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap on_error ERR

tar czf "$OUT/vaporzr-data-$STAMP.tgz" \
  -C "$DATA" \
  --exclude-from="$EXCLUDES" \
  .

# Rotate: keep the newest $KEEP archives.
ls -1t "$OUT"/vaporzr-data-*.tgz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "backup ok: $OUT/vaporzr-data-$STAMP.tgz ($(du -h "$OUT/vaporzr-data-$STAMP.tgz" | cut -f1))"

# Off-site copy. Deliberately NOT optional when configured: a job that reports
# success while the remote is empty is how the five-week gap happened. Any
# failure here fails the whole run (set -e), which triggers the heartbeat above.
ran_offsite=0
if [ -x /opt/vaporzr/backup-offsite.sh ] && [ -n "${RESTIC_REPOSITORY:-}" ]; then
  /opt/vaporzr/backup-offsite.sh
  ran_offsite=1
fi
if [ -x /opt/vaporzr/backup-github.sh ] && [ -n "${GH_BACKUP_REPO:-}" ]; then
  /opt/vaporzr/backup-github.sh
  ran_offsite=1
fi

if [ "$ran_offsite" -eq 0 ]; then
  echo "!! no off-site target configured (RESTIC_REPOSITORY or GH_BACKUP_REPO)" >&2
  echo "   local archives live on the same disk as the data they protect." >&2
  echo "   see docs/BACKUPS.md" >&2
fi

# Success ping. healthchecks.io emails when this stops arriving — the outside
# signal that a dead host cannot silence.
if [ -n "${BACKUP_HEALTHCHECK_URL:-}" ]; then
  curl -fsS -m 10 --retry 2 "$BACKUP_HEALTHCHECK_URL" >/dev/null 2>&1 || true
fi
