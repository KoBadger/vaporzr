#!/usr/bin/env bash
# Vaporzr VPS redeploy — pull the CI-built image and recreate the container.
#
# This is the BREAK-GLASS / manual path. The normal path is GitHub Actions
# (.github/workflows/deploy.yml), which builds the image (including compiling
# the Linux librespot binary the Dockerfile COPYs) and rolls the container on
# every push to master. This script only pulls an already-published image — it
# never builds, so it can't hit the missing-binary trap a tarball build does.
#
# Usage (on the VPS):
#   bash vps-redeploy.sh              # deploy :latest
#   bash vps-redeploy.sh <git-sha>    # deploy a specific commit image
#   IMAGE=ghcr.io/you/fork-bot bash vps-redeploy.sh <tag>
#
# If the GHCR package is private, log in first (or export GHCR_TOKEN):
#   echo "$GHCR_TOKEN" | docker login ghcr.io -u <user> --password-stdin
#
# Requires /opt/vaporzr/.env (see vps-setup.sh). Mounts /opt/vaporzr/cookies.txt
# read-only when present.

set -euo pipefail

APP_DIR=/opt/vaporzr
CONTAINER=vaporzr
IMAGE="${IMAGE:-ghcr.io/kobadger/vaporzr/vaporzr-bot}"
TAG="${1:-latest}"
PORT=4876

REF="$IMAGE:$TAG"

if [ ! -f "$APP_DIR/.env" ]; then
  echo "!! No $APP_DIR/.env found (see vps-setup.sh)."
  exit 1
fi

if [ -n "${GHCR_TOKEN:-}" ]; then
  echo "==> Logging in to ghcr.io"
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-github}" --password-stdin
fi

echo "==> Pulling $REF"
if ! docker pull "$REF"; then
  # A stale/expired ghcr.io credential (or a registry rate-limit) makes the pull
  # fail even though CI can push. Don't hard-abort with the old container still
  # running stale config — fall back to the local image when there is one.
  if docker image inspect "$REF" >/dev/null 2>&1; then
    echo "!! Pull failed - falling back to the local $REF image and continuing."
  else
    # CI tags by git sha (not :latest), so the local tag is often absent. Fall
    # back to whatever image the running container is already on.
    RUNNING_IMG=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)
    if [ -n "$RUNNING_IMG" ] && docker image inspect "$RUNNING_IMG" >/dev/null 2>&1; then
      echo "!! Pull failed - falling back to the running container's image ($RUNNING_IMG)."
      REF="$RUNNING_IMG"
    else
      echo "!! Pull failed and no usable local image exists - aborting before touching the container."
      exit 1
    fi
  fi
fi

echo "==> Smoke-testing the image before touching the running container"
docker run --rm "$REF" sh -c "cd /app/apps/bot && tsx smoke-persist.ts"

echo "==> Ensuring PO-token provider (host loopback :4416)"
if ! docker container inspect bgutil-provider >/dev/null 2>&1; then
  docker pull brainicism/bgutil-ytdlp-pot-provider
  docker run -d --name bgutil-provider --init --restart unless-stopped \
    --network host \
    brainicism/bgutil-ytdlp-pot-provider
fi

docker volume inspect vaporzr-data >/dev/null 2>&1 || docker volume create vaporzr-data

COOKIE_MOUNT=()
if [ -f "$APP_DIR/cookies.txt" ]; then
  echo "==> cookies.txt found — will mount read-only"
  COOKIE_MOUNT=(-v "$APP_DIR/cookies.txt:/app/data/cookies.txt:ro")
fi

echo "==> Stopping old container"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
echo "==> Starting container"
# BIND_ADDRESS=127.0.0.1 keeps the control server on the loopback; with host
# networking it stays reachable as 127.0.0.1 from a tunnel but not the internet.
docker run -d --name "$CONTAINER" \
  --restart unless-stopped \
  --network host \
  --env-file "$APP_DIR/.env" \
  -e BIND_ADDRESS=127.0.0.1 \
  -v vaporzr-data:/app/data \
  "${COOKIE_MOUNT[@]}" \
  "$REF"

docker image prune -f >/dev/null 2>&1 || true
# Keep the 6 newest bot images (current + rollback targets).
docker images --format '{{.ID}} {{.CreatedAt}}' "$IMAGE" \
  | sort -k2 -r | tail -n +7 | awk '{print $1}' | sort -u \
  | xargs -r docker rmi -f >/dev/null 2>&1 || true

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
