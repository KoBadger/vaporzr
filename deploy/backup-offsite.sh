#!/usr/bin/env bash
# Off-site restic snapshot of the vaporzr-data volume.
#
# Why this exists: the previous off-host copy was a GitHub Actions workflow that
# reached the VPS over SSH. GitHub's runner IPs could not get to port 22, so all
# five scheduled runs failed at `dial tcp …:22` and no artifact was ever
# produced — five weeks of silence, discovered only when the host itself went
# away. This pushes *out* from the VPS instead: no inbound access for anyone,
# nothing to allowlist, and an incremental, deduplicated, encrypted repository
# so nightly runs cost almost nothing.
#
# Install (on the VPS):
#   install -m 755 deploy/backup-offsite.sh   /opt/vaporzr/backup-offsite.sh
#   install -m 600 deploy/backup.env.example  /etc/vaporzr/backup.env  # then edit
#   # run it once by hand to initialise the repository, then let the nightly
#   # backup.sh call it (see the tail of backup.sh).
#
# Restore: docs/BACKUPS.md. The one rule: RESTIC_PASSWORD must also live in a
# password manager. Keeping it only on the VPS is how a backup becomes a
# curiosity the day the VPS disappears.
set -euo pipefail

DATA=/var/lib/docker/volumes/vaporzr-data/_data
ENV_FILE=/etc/vaporzr/backup.env
STATE="$DATA/backup-state.json"
ERRFILE="$DATA/backup-last-error.txt"
IMAGE=${RESTIC_IMAGE:-restic/restic:0.17.3}

if [ ! -f "$ENV_FILE" ]; then
  echo "!! $ENV_FILE missing — no off-site target configured" >&2
  exit 1
fi
if [ ! -d "$DATA" ]; then
  echo "!! data volume not found at $DATA" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is required}"

# Record the failure where /health can see it. The success marker is left
# untouched, so its age keeps growing instead of resetting on a failed night.
on_error() {
  local code=$?
  echo "!! off-site backup failed (exit $code)" >&2
  printf '%s restic backup exited %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" > "$ERRFILE"
}
trap on_error ERR

restic() {
  docker run --rm \
    -v vaporzr-data:/data:ro \
    -e RESTIC_REPOSITORY \
    -e RESTIC_PASSWORD \
    -e AWS_ACCESS_KEY_ID \
    -e AWS_SECRET_ACCESS_KEY \
    -e AWS_DEFAULT_REGION \
    -e RESTIC_CACHE_DIR=/tmp/restic-cache \
    "$IMAGE" "$@"
}

# First run on a fresh bucket: create the repository instead of failing on it.
if ! restic cat config >/dev/null 2>&1; then
  echo "==> initialising restic repository at $RESTIC_REPOSITORY"
  restic init
fi

# Same exclusions as the local archive: the caches are rebuildable, the state is
# not. `--exclude` patterns are absolute because the backup path is /data.
restic backup /data \
  --host vaporzr \
  --tag nightly \
  --exclude '/data/go-librespot' \
  --exclude '/data/video-cache' \
  --exclude '/data/stems' \
  --exclude '/data/hf' \
  --exclude '/data/torch' \
  --exclude '/data/decks' \
  --exclude '/data/tmp' \
  --exclude '/data/backup-state.json' \
  --exclude '/data/backup-last-error.txt' \
  --verbose

# Retention. Daily for a week, weekly for a month, monthly for six — enough to
# notice a corruption or a bad migration long after it happened.
restic forget \
  --host vaporzr \
  --keep-daily 7 \
  --keep-weekly 5 \
  --keep-monthly 6 \
  --prune

# Cheap structural check every night; `--read-data` belongs in a monthly job.
restic check

STAMP_MS="$(date +%s)000"
printf '{"at":%s,"target":"%s","host":"%s"}\n' \
  "$STAMP_MS" "$RESTIC_REPOSITORY" "$(hostname)" > "$STATE"
rm -f "$ERRFILE"

echo "==> off-site backup ok: $(restic snapshots --host vaporzr --latest 1 | tail -n 1)"
