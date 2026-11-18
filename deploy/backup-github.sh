#!/usr/bin/env bash
# Off-site backup with no payment method: upload the newest encrypted archive as
# a GitHub Release asset.
#
# Why this exists next to backup-offsite.sh (restic → S3): every S3-compatible
# free tier worth using — Cloudflare R2, Backblaze B2 — asks for a card on file
# even at zero spend. On an account whose card just failed, "free" has to mean
# free. A release asset costs nothing, needs no new account, and the encrypted
# blob is useless without the passphrase, so a private repo is belt and braces
# rather than the only protection.
#
# Setup:
#   1. Create a PRIVATE repo (e.g. `vaporzr-backups`) — it holds only ciphertext.
#   2. Create a token with write access to it (classic: `repo` scope; fine-grained:
#      Contents → Read and write).
#   3. In /etc/vaporzr/backup.env set GH_BACKUP_REPO=owner/vaporzr-backups and
#      GH_BACKUP_TOKEN=<token>.
#
# Requires: curl, openssl, python3 (all present on Debian/Ubuntu images).
set -euo pipefail

DATA=/var/lib/docker/volumes/vaporzr-data/_data
OUT=/opt/backups
ENV_FILE=/etc/vaporzr/backup.env
STATE="$DATA/backup-state.json"
ERRFILE="$DATA/backup-last-error.txt"
TAG=backup-rolling
KEEP_ASSETS=${GH_BACKUP_KEEP:-6}

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a
  . "$ENV_FILE"
  set +a
fi

: "${GH_BACKUP_REPO:?GH_BACKUP_REPO is required (owner/repo)}"
: "${GH_BACKUP_TOKEN:?GH_BACKUP_TOKEN is required}"
PASSFILE=${BACKUP_PASSPHRASE_FILE:-/opt/vaporzr/backup-passphrase.txt}
if [ ! -f "$PASSFILE" ]; then
  echo "!! passphrase file not found: $PASSFILE" >&2
  exit 1
fi

for bin in curl openssl python3; do
  command -v "$bin" >/dev/null || {
    echo "!! $bin is required for the GitHub backup target" >&2
    exit 1
  }
done

SOURCE=$(ls -1t "$OUT"/vaporzr-data-*.tgz 2>/dev/null | head -n 1 || true)
if [ -z "$SOURCE" ]; then
  echo "!! no local archive found in $OUT" >&2
  exit 1
fi

API=https://api.github.com/repos/$GH_BACKUP_REPO
# Asset uploads live on a different host than the rest of the API; posting to
# api.github.com/releases/{id}/assets returns 404 and looks like a bad id.
UPLOAD=https://uploads.github.com/repos/$GH_BACKUP_REPO
NAME="$(basename "$SOURCE").enc"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

api() {
  curl -fsS --connect-timeout 30 \
    -H "Authorization: Bearer $GH_BACKUP_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

json_field() {
  python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"
}

echo "==> encrypting $(basename "$SOURCE") ($(du -h "$SOURCE" | cut -f1))"
openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$PASSFILE" \
  -in "$SOURCE" -out "$TMP/$NAME"

# One rolling release, created on first use. A release per month would leave
# empty shells behind; one release with pruned assets is easier to audit.
if ! release=$(api "$API/releases/tags/$TAG" 2>/dev/null); then
  echo "==> creating release $TAG"
  release=$(api -X POST "$API/releases" \
    -d "{\"tag_name\":\"$TAG\",\"name\":\"Vaporzr data backups\",\"body\":\"AES-256 (openssl pbkdf2) snapshots of vaporzr-data. Useless without the passphrase.\",\"prerelease\":true}")
fi
RELEASE_ID=$(printf '%s' "$release" | json_field id)
if [ -z "$RELEASE_ID" ]; then
  echo "!! could not resolve the release id" >&2
  exit 1
fi

echo "==> uploading $NAME to $GH_BACKUP_REPO release $TAG ($RELEASE_ID)"
api -X POST --connect-timeout 30 \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@$TMP/$NAME" \
  "$UPLOAD/releases/$RELEASE_ID/assets?name=$NAME" >/dev/null

# Retention: newest $KEEP_ASSETS names win (names carry YYYYMMDD-HHMM).
api "$API/releases/$RELEASE_ID/assets?per_page=100" |
  python3 -c '
import json, sys
keep = int(sys.argv[1])
items = sorted(json.load(sys.stdin), key=lambda a: a.get("name", ""), reverse=True)
for asset in items[keep:]:
    print(asset["id"])
' "$KEEP_ASSETS" |
  while read -r asset_id; do
    [ -n "$asset_id" ] || continue
    api -X DELETE "$API/releases/assets/$asset_id" >/dev/null || true
  done

printf '{"at":%s,"target":"github:%s","host":"%s"}\n' \
  "$(date +%s)000" "$GH_BACKUP_REPO" "$(hostname)" > "$STATE"
rm -f "$ERRFILE"
echo "==> github backup ok: $GH_BACKUP_REPO/$TAG/$NAME"
