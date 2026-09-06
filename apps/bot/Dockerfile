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
# - The container binds the control server + WS bridge to 127.0.0.1:4876
#   (BIND_ADDRESS default here). Do NOT publish -p 4876:4876. To open the
#   browser panel / visualizer from your machine, SSH-tunnel the port instead:
#       ssh -N -L 4876:127.0.0.1:4876 user@your-vps
#   then browse to http://127.0.0.1:4876/panel. If you DO want it reachable
#   from the internet instead, override BIND_ADDRESS=0.0.0.0 AND set SHARE_KEY
#   to gate /panel + /viz + the WS bridge (they are unauthenticated otherwise).
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

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates ffmpeg python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g tsx \
    && python3 -m venv /opt/ytvenv \
    && /opt/ytvenv/bin/pip install --no-cache-dir --upgrade yt-dlp bgutil-ytdlp-pot-provider \
    && ln -s /opt/ytvenv/bin/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app

COPY --from=build /app ./
COPY librespot /usr/local/bin/librespot

ENV NODE_ENV=production \
    PORT=4876 \
    BIND_ADDRESS=127.0.0.1 \
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
