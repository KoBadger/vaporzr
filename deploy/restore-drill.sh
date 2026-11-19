#!/usr/bin/env bash
# Restore drill: prove the off-site backup can actually be brought back, and that
# it holds everything the bot needs.
#
# A backup nobody has restored is a belief. This downloads the newest encrypted
# asset from the off-site target, decrypts it with the nightly job's passphrase,
# extracts it to scratch space, and then compares against the live volume: every
# live state file that existed when the snapshot was taken must be present in the
# restored tree. That comparison is the check that found `decks/` missing from
# every backup, which integrity checking alone would never have caught.
#
# Nothing on the running bot is touched: no volume is overwritten, no second bot
# process connects to Discord.
#
# Install on the VPS (next to backup.sh) and run it monthly, or after changing
# the exclusion list:
#   install -m 755 deploy/restore-drill.sh     /opt/vaporzr/restore-drill.sh
#   install -m 644 deploy/backup-excludes.txt  /opt/vaporzr/backup-excludes.txt
#   /opt/vaporzr/restore-drill.sh
#
# Keep the extracted tree for inspection with RESTORE_DRILL_KEEP=1.
set -uo pipefail

DATA=${DATA_DIR:-/var/lib/docker/volumes/vaporzr-data/_data}
WORK=${RESTORE_DRILL_DIR:-/var/tmp/restore-drill}
PASSFILE=${BACKUP_PASSPHRASE_FILE:-/opt/vaporzr/backup-passphrase.txt}
EXCLUDES=${BACKUP_EXCLUDES_FILE:-/opt/vaporzr/backup-excludes.txt}
ENV_FILE=${BACKUP_ENV_FILE:-/etc/vaporzr/backup.env}
TAG=${GH_BACKUP_TAG:-backup-rolling}

fail() {
  echo "DRILL FAILED: $*" >&2
  echo "  scratch tree kept at $WORK for inspection" >&2
  exit 1
}

[ -d "$DATA" ] || fail "data volume not found at $DATA"
[ -f "$PASSFILE" ] || fail "passphrase file not found at $PASSFILE"
[ -f "$EXCLUDES" ] || fail "exclusion list not found at $EXCLUDES"
[ -f "$ENV_FILE" ] || fail "env file not found at $ENV_FILE"

rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK" || fail "cannot use $WORK"

# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a
: "${GH_BACKUP_REPO:?GH_BACKUP_REPO is required (set it in $ENV_FILE)}"
: "${GH_BACKUP_TOKEN:?GH_BACKUP_TOKEN is required (set it in $ENV_FILE)}"

echo '--- 1. newest off-site asset ---'
ASSET_URL=$(curl -fsS --connect-timeout 20 \
  -H "Authorization: Bearer $GH_BACKUP_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$GH_BACKUP_REPO/releases/tags/$TAG" |
  python3 -c 'import json,sys
d = json.load(sys.stdin)
a = sorted(d.get("assets", []), key=lambda x: x.get("name", ""), reverse=True)
print(a[0]["url"] if a else "")')
[ -n "$ASSET_URL" ] || fail "no assets in $GH_BACKUP_REPO@$TAG"
echo "asset: $ASSET_URL"

echo '--- 2. download ---'
curl -fsSL --connect-timeout 30 --retry 3 \
  -H "Authorization: Bearer $GH_BACKUP_TOKEN" \
  -H "Accept: application/octet-stream" \
  "$ASSET_URL" -o archive.tgz.enc || fail 'download failed'
echo "size: $(du -h archive.tgz.enc | cut -f1)  sha256: $(sha256sum archive.tgz.enc | cut -d' ' -f1)"

echo '--- 3. decrypt (this is the step that proves the passphrase) ---'
openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$PASSFILE" \
  -in archive.tgz.enc -out archive.tgz || fail 'decrypt failed (wrong passphrase?)'
gzip -t archive.tgz || fail 'decrypted archive is not a valid gzip'
echo 'gzip integrity: ok'

echo '--- 4. extract to scratch ---'
mkdir -p root
tar -xzf archive.tgz -C root || fail 'tar extraction failed'
echo "restored: $(du -sh root | cut -f1) in $(find root -type f | wc -l) files"

echo '--- 5. every state JSON must parse ---'
python3 - <<'PY' || fail 'unreadable JSON in the restored tree'
import json, pathlib, sys
ok = bad = 0
for p in pathlib.Path('root').rglob('*.json'):
    try:
        json.loads(p.read_text())
        ok += 1
    except Exception as e:
        bad += 1
        print('  BAD', p, e)
print(f'json files ok={ok} bad={bad}')
sys.exit(1 if bad else 0)
PY

echo '--- 6. completeness: every live state file must be in the restore ---'
DATA_DIR="$DATA" EXCLUDES_FILE="$EXCLUDES" python3 - <<'PY' || fail 'restored tree is missing state files'
import json, os, pathlib, sys, time

live = pathlib.Path(os.environ['DATA_DIR'])
rest = pathlib.Path('root')
excludes = {
    line.strip()
    for line in pathlib.Path(os.environ['EXCLUDES_FILE']).read_text().splitlines()
    if line.strip() and not line.startswith('#')
}

state = live / 'backup-state.json'
if state.exists():
    backup_at = json.loads(state.read_text())['at'] / 1000
else:
    print('  (no backup-state.json — cannot tell which files postdate the snapshot)')
    backup_at = time.time()

missing, expected, newer = [], 0, 0
for p in live.rglob('*'):
    if not p.is_file():
        continue
    rel = p.relative_to(live)
    if rel.parts[0] in excludes or rel.name in excludes:
        continue
    if p.suffix in {'.log', '.tmp'}:
        continue
    if p.stat().st_mtime > backup_at + 60:
        newer += 1
        continue
    expected += 1
    if not (rest / rel).exists():
        missing.append(str(rel))

print(f'state files expected in the backup: {expected}')
print(f'files written after the snapshot (excluded): {newer}')
if missing:
    print(f'MISSING {len(missing)}:')
    for m in missing[:15]:
        print('  -', m)
    sys.exit(1)
print('completeness: every state file is present')
PY

echo '--- 7. spot-check what a recovery actually needs ---'
for p in queues guilds decks taste presets samples playlists suno stems uploads; do
  printf '  %-10s %s files\n' "$p" "$(find "root/$p" -type f 2>/dev/null | wc -l)"
done
q=$(find root/queues -name '*.json' | head -1)
if [ -n "$q" ]; then
  python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
print("  sample queue:", sys.argv[1], "->", list(d)[:8] if isinstance(d, dict) else f"list[{len(d)}]")' "$q"
fi

echo '--- 8. cleanup ---'
if [ "${RESTORE_DRILL_KEEP:-0}" = "1" ]; then
  echo "kept: $WORK"
else
  cd /
  rm -rf "$WORK"
fi
echo "DRILL OK: off-site asset downloaded, decrypted, verified, extracted, and complete."
