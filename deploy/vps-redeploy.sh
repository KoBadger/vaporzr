#!/usr/bin/env bash
# Vaporzr VPS redeploy — build the image ON the VPS from a source tarball and
# recreate the container. Used when the local Docker Desktop is unavailable
# (or just to keep build load off the dev machine).
#
# Usage:
#   1. From the repo root (Windows/PowerShell or bash), stage + ship a tarball:
#        tar -cf vaporzr-deploy.tar package.json package-lock.json \
#            packages/shared apps/bot apps/player apps/spicetify \
#            --exclude=node_modules --exclude=apps/bot/data
#        scp vaporzr-deploy.tar root@<vps>:/opt/vaporzr-deploy.tar
#      (robocopy to a staging dir first on Windows if tar excludes misbehave)
#   2. ssh in, then:  bash vps-redeploy.sh [/opt/vaporzr-deploy.tar]
#
# Safe to re-run. Requires /opt/vaporzr/.env (see vps-setup.sh). Mounts
# /opt/vaporzr/cookies.txt read-only when present and points
# YOUTUBE_COOKIES_PATH at it (add that line to .env once; vps-setup.sh does
# this automatically).

set -euo pipefail

APP_DIR=/opt/vaporzr
CONTAINER=vaporzr
IMAGE=kobadger/vaporzr-bot:latest
PORT=4876
TARBALL="${1:-/opt/vaporzr-deploy.tar}"
BUILD_DIR=/opt/vaporzr-build

if [ ! -f "$TARBALL" ]; then
  echo "!! No tarball at $TARBALL — ship the repo tarball first (see header)."
  exit 1
fi
if [ ! -f "$APP_DIR/.env" ]; then
  echo "!! No $APP_DIR/.env found (see vps-setup.sh)."
  exit 1
fi

echo "==> Extracting source"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
tar -xf "$TARBALL" -C "$BUILD_DIR" 2>/dev/null

echo "==> Building $IMAGE (amd64, on this host)"
docker build -f "$BUILD_DIR/apps/bot/Dockerfile" -t "$IMAGE" "$BUILD_DIR"

COOKIE_MOUNT=()
if [ -f "$APP_DIR/cookies.txt" ]; then
  echo "==> cookies.txt found — will mount read-only"
  COOKIE_MOUNT=(-v "$APP_DIR/cookies.txt:/app/data/cookies.txt:ro")
else
  echo "==> no cookies.txt — YouTube may throttle/403 from this IP"
fi

docker volume inspect vaporzr-data >/dev/null 2>&1 || docker volume create vaporzr-data

echo "==> Stopping old container"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
echo "==> Starting container"
# Host networking keeps the loopbound control server (BIND_ADDRESS=127.0.0.1)
# reachable as 127.0.0.1 from the host; see vps-setup.sh.
docker run -d --name "$CONTAINER" \
  --restart unless-stopped \
  --network host \
  --env-file "$APP_DIR/.env" \
  -e BIND_ADDRESS=127.0.0.1 \
  -v vaporzr-data:/app/data \
  "${COOKIE_MOUNT[@]}" \
  "$IMAGE"

echo "==> Waiting for health check"
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "==> Healthy:"
    curl -s "http://127.0.0.1:$PORT/health"
    echo
    echo "==> Done. Logs: docker logs -f $CONTAINER"
    exit 0
  fi
  sleep 2
  if [ "$i" -eq 30 ]; then
    echo "!! Bot did not become healthy in 60s — logs:"
    docker logs --tail 40 "$CONTAINER"
    exit 1
  fi
done
