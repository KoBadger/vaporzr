#!/usr/bin/env bash
# Vaporzr VPS one-shot provisioning — run as root on a fresh Debian 12/Ubuntu
# 22.04+ box (Hetzner CX22 or similar). Safe to re-run: every step checks
# before acting.
#
# Usage:
#   1. scp this script + apps/bot/.env (+ cookies.txt if you have one) to the VPS
#   2. ssh in, then:  bash vps-setup.sh
#
# Posture: control server bound to 127.0.0.1 (SSH tunnel to reach /panel + /viz),
# container auto-restarts, data in the vaporzr-data volume.

set -euo pipefail

APP_DIR=/opt/vaporzr
CONTAINER=vaporzr
IMAGE=kobadger/vaporzr-bot:latest
PORT=4876

echo "==> Vaporzr VPS setup"

# --- 1. Docker -------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | sh
else
  echo "==> Docker present: $(docker --version)"
fi

# --- 2. Layout -------------------------------------------------------------
mkdir -p "$APP_DIR"
if [ ! -f "$APP_DIR/.env" ]; then
  echo "!! No $APP_DIR/.env found."
  echo "   scp your apps/bot/.env here first (needs at least DISCORD_TOKEN)."
  exit 1
fi

# --- 3. Cookies (optional but strongly recommended on datacenter IPs) ------
# Normalize the path for the container regardless of what the local .env had
# (a Windows-style path would either point nowhere or make yt-dlp fail on a
# missing file). Strip the line, then re-add the container path only if the
# cookies file actually shipped.
sed -i '/^YOUTUBE_COOKIES_PATH=/d' "$APP_DIR/.env"
COOKIE_MOUNT=()
if [ -f "$APP_DIR/cookies.txt" ]; then
  echo "==> cookies.txt found — will mount read-only"
  echo "YOUTUBE_COOKIES_PATH=/app/data/cookies.txt" >> "$APP_DIR/.env"
  COOKIE_MOUNT=(-v "$APP_DIR/cookies.txt:/app/data/cookies.txt:ro")
else
  echo "==> no cookies.txt — YouTube may throttle/403 from this IP"
fi

# --- 4. Data volume --------------------------------------------------------
docker volume inspect vaporzr-data >/dev/null 2>&1 || docker volume create vaporzr-data

# --- 4b. PO-token provider (bgutil) -----------------------------------------
# YouTube refuses format extraction from datacenter IPs without a PO token
# ("Sign in to confirm you're not a bot" / empty format lists). The bgutil
# provider generates them; the yt-dlp plugin baked into the bot image
# auto-detects the server at http://127.0.0.1:4416 (host networking).
if docker container inspect bgutil-provider >/dev/null 2>&1; then
  echo "==> bgutil PO-token provider present"
else
  echo "==> starting bgutil PO-token provider (port 4416)"
  docker pull brainicism/bgutil-ytdlp-pot-provider
  docker run -d --name bgutil-provider --init --restart unless-stopped \
    --network host \
    brainicism/bgutil-ytdlp-pot-provider
fi

# --- 5. Pull + (re)start ---------------------------------------------------
echo "==> Pulling $IMAGE"
docker pull "$IMAGE"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
echo "==> Starting container"
# Use host networking so the control server's loopback binding (BIND_ADDRESS)
# is directly reachable as 127.0.0.1 from the host — the docker-proxy path
# resets connections when the app binds container-localhost. Bot-only traffic
# is outbound; nothing needs a published port here.
docker run -d --name "$CONTAINER" \
  --restart unless-stopped \
  --network host \
  --env-file "$APP_DIR/.env" \
  -e BIND_ADDRESS=127.0.0.1 \
  -v vaporzr-data:/app/data \
  "${COOKIE_MOUNT[@]}" \
  "$IMAGE"

# --- 6. Verify -------------------------------------------------------------
echo "==> Waiting for health check"
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "==> Healthy:"
    curl -s "http://127.0.0.1:$PORT/health"
    echo
    break
  fi
  sleep 2
  if [ "$i" -eq 30 ]; then
    echo "!! Bot did not become healthy in 60s — logs:"
    docker logs --tail 40 "$CONTAINER"
    exit 1
  fi
done

echo
echo "==> Done. From YOUR machine, open the panel with:"
echo "      ssh -N -L $PORT:127.0.0.1:$PORT root@$(hostname -I | awk '{print $1}')"
echo "    then browse http://127.0.0.1:$PORT/panel"
echo "==> Logs:      docker logs -f $CONTAINER"
echo "==> Restart:   docker restart $CONTAINER"
echo "==> Upgrade:   docker pull $IMAGE && bash $0"
