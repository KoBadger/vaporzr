# Vaporzr bot — headless multi-server hosting. On a VPS the Discord panel +
# commands give every server the full control surface; the Electron overlay /
# player windows stay local on the host machine (owner-gated, so they simply
# error out headlessly if someone triggers them — harmless).
#
# Build:   docker build -f apps/bot/Dockerfile -t vaporzr-bot .
# Run (from the repo root, secrets stay out of the image via --env-file):
#   docker run -d --name vaporzr \
#     --restart unless-stopped \
#     --env-file apps/bot/.env \
#     -v vaporzr-data:/app/data \
#     vaporzr-bot
#
# NOTES
# - The container binds the control server + WS bridge to 0.0.0.0:4876
#   (BIND_ADDRESS default here) so Docker's port mapping can reach it. The
#   port is only ever published to the host's loopback (-p 127.0.0.1:4876:4876),
#   never to the internet. To open the browser panel / visualizer from your
#   machine, SSH-tunnel the port instead:
#       ssh -N -L 4876:127.0.0.1:4876 user@your-vps
#   then browse to http://127.0.0.1:4876/panel. If you DO want it reachable
#   from the internet instead, publish it AND set SHARE_KEY to gate /panel +
#   /viz + the WS bridge (they are unauthenticated otherwise).
# - Spotify linking: with SPOTIFY_PREFER_YOUTUBE=0 (multi-guild mode) and
#   SPOTIFY_USE_ANONYMOUS=1 (default) no account link is required. If you need
#   full-length public playlists, set SPOTIFY_SP_DC in .env. To keep an existing
#   OAuth link, copy apps/bot/data (tokens.json) into the vaporzr-data volume.
# - The bot runs TypeScript directly (tsx), so no compile step is needed.

FROM node:20-trixie-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 python3-pip ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared ./packages/shared
COPY apps/bot ./apps/bot
COPY apps/player ./apps/player
COPY apps/spicetify ./apps/spicetify

RUN npm ci --omit=dev

FROM node:20-trixie-slim AS runtime

ARG GIT_SHA=dev

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates ffmpeg espeak-ng python3 python3-venv curl pulseaudio pulseaudio-utils \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g tsx \
    && python3 -m venv /opt/ytvenv \
    && /opt/ytvenv/bin/pip install --no-cache-dir --upgrade yt-dlp bgutil-ytdlp-pot-provider \
    && ln -s /opt/ytvenv/bin/yt-dlp /usr/local/bin/yt-dlp \
    && /opt/ytvenv/bin/pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch torchaudio \
    && /opt/ytvenv/bin/pip install --no-cache-dir demucs numpy \
    && ln -s /opt/ytvenv/bin/demucs /usr/local/bin/demucs \
    && curl -fsSL -o /tmp/glr.tar.gz https://github.com/devgianlu/go-librespot/releases/download/v0.10.0/go-librespot_linux_x86_64.tar.gz \
    && tar -xzf /tmp/glr.tar.gz -C /tmp \
    && install -m 755 /tmp/go-librespot /usr/local/bin/go-librespot \
    && rm -f /tmp/glr.tar.gz /tmp/go-librespot

WORKDIR /app

# yt-dlp's EJS needs a JavaScript runtime to solve YouTube's signature/n-sig
# challenges; Deno is its default. Node is NOT accepted as the EJS runtime.
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

COPY --from=build /app ./
COPY librespot /usr/local/bin/librespot

ENV NODE_ENV=production \
    VAPORZR_BUILD=$GIT_SHA \
    TORCH_HOME=/app/data/torch \
    SPOTIFY_BACKEND=librespot \
    GO_LIBRESPOT_PATH=/usr/local/bin/go-librespot \
    PORT=4876 \
    BIND_ADDRESS=0.0.0.0 \
    DATA_DIR=/app/data \
    YT_DLP_PATH=/usr/local/bin/yt-dlp \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    LIBRESPOT_PATH=/usr/local/bin/librespot \
    SPOTIFY_PREFER_YOUTUBE=0 \
    PLAYER_DIR=/dev/null \
    ELECTRON_PATH=/bin/true

# Health check: hits the /health endpoint every 30s, fails after 3 retries (90s).
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "const http=require('http');const p=process.env.PORT||4876;const r=http.get('http://127.0.0.1:'+p+'/health',s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>process.exit(s.statusCode===200?0:1))});r.on('error',()=>process.exit(1));r.setTimeout(5000,()=>{r.destroy();process.exit(1)})"

VOLUME /app/data

CMD ["tsx", "apps/bot/src/index.ts"]
