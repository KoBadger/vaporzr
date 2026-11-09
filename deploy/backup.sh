#!/usr/bin/env bash
# Nightly Vaporzr data backup.
#
# Backs up the durable state (queues, tokens, keys, samples, uploads, stats)
# and skips the rebuildable caches (go-librespot, video-cache, stems, hf) so a
# 2.8 GB volume does not turn into tens of GB of rotated archives.
#
# Install on the VPS:
#   install -m 755 deploy/backup.sh /opt/vaporzr/backup.sh
#   (crontab -l; echo "0 4 * * * /opt/vaporzr/backup.sh >> /var/log/vaporzr-backup.log 2>&1") | crontab -
set -euo pipefail

DATA=/var/lib/docker/volumes/vaporzr-data/_data
OUT=/opt/backups
KEEP=7
STAMP=$(date +%Y%m%d-%H%M)

if [ ! -d "$DATA" ]; then
  echo "!! data volume not found at $DATA" >&2
  exit 1
fi
mkdir -p "$OUT"

tar czf "$OUT/vaporzr-data-$STAMP.tgz" \
  -C "$DATA" \
  --exclude=go-librespot \
  --exclude=video-cache \
  --exclude=hf \
  --exclude=stems \
  --exclude=decks \
  --exclude=tmp \
  .

# Rotate: keep the newest $KEEP archives.
ls -1t "$OUT"/vaporzr-data-*.tgz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "backup ok: $OUT/vaporzr-data-$STAMP.tgz ($(du -h "$OUT/vaporzr-data-$STAMP.tgz" | cut -f1))"
