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

# Self-check, prepared before the archive so a file created mid-run cannot cause
# a false alarm. A backup that silently omits something looks exactly like a good
# one until the day it is restored: that is how users' `decks/` went missing from
# every archive for months. This list is every state file that is NOT excluded —
# if the archive does not contain one of them, the run fails loudly instead of
# uploading an incomplete snapshot over a complete one.
STATE_LIST=$(mktemp)
ARCHIVE_LIST=$(mktemp)
MISSING=$(mktemp)
trap 'rm -f "${STATE_LIST:-}" "${ARCHIVE_LIST:-}" "${MISSING:-}"' EXIT
# Prefix matching, not a regex built from the file: the exclusion list is a list
# of names, and a name containing a dot must not quietly become a wildcard.
find "$DATA" -type f -printf '%P\n' |
  awk -v excl="$EXCLUDES" '
    BEGIN { while ((getline line < excl) > 0) {
              gsub(/^[ \t]+|[ \t]+$/, "", line)
              if (line == "" || substr(line, 1, 1) == "#") continue
              n++; pats[n] = line } }
    { if ($0 ~ /\.(log|tmp)$/) next
      for (i = 1; i <= n; i++) if ($0 == pats[i] || index($0, pats[i] "/") == 1) next
      print }' |
  LC_ALL=C sort >"$STATE_LIST" || true

tar czf "$OUT/vaporzr-data-$STAMP.tgz" \
  -C "$DATA" \
  --exclude-from="$EXCLUDES" \
  .

# LC_ALL=C on both sorts and on comm: `comm` compares bytes and rejects input it
# considers unsorted, and in the default locale `sort` orders differently — the
# first production run printed "comm: input is not in sorted order" and still
# reported no gaps, which is a false negative in the one check that guards the
# backup.
tar tzf "$OUT/vaporzr-data-$STAMP.tgz" | sed 's|^\./||' | grep -v '/$' |
  LC_ALL=C sort >"$ARCHIVE_LIST" || true
LC_ALL=C comm -23 "$STATE_LIST" "$ARCHIVE_LIST" >"$MISSING" || true
if [ -s "$MISSING" ]; then
  count=$(wc -l <"$MISSING")
  echo "!! backup incomplete: $count state file(s) missing from the archive:" >&2
  head -20 "$MISSING" >&2 || true
  printf 'backup.sh: archive missing %s state file(s), first: %s\n' \
    "$count" "$(head -1 "$MISSING")" >"$ERRFILE"
  rm -f "$OUT/vaporzr-data-$STAMP.tgz"
  exit 1
fi
echo "self-check: $(wc -l <"$ARCHIVE_LIST") files archived, no state gaps"

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
