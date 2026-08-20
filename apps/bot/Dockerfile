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
# - Do NOT publish -p 4876:4876. The control server + WS bridge bind to
#   127.0.0.1:4876 and have no auth; keep them local to the VPS. To open the
#   browser panel from your machine, SSH-tunnel the port instead.
# - Spotify linking: with SPOTIFY_PREFER_YOUTUBE=1 (multi-guild mode) and
#   SPOTIFY_USE_ANONYMOUS=1 (default) no account link is required. If you need
#   full-length public playlists, set SPOTIFY_SP_DC in .env. To keep an existing
#   OAuth link, copy apps/bot/data (tokens.json) into the vaporzr-data volume.
# - The bot runs TypeScript directly (tsx), so no compile step is needed.

FROM node:20-bookworm-slim AS build

# opusscript compiles a native binding; ffmpeg streams audio server-side.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 python3-pip ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Workspace manifests + sources (see .dockerignore for what is excluded).
COPY package.json package-lock.json ./
COPY packages/shared ./packages/shared
COPY apps/bot ./apps/bot
COPY apps/player ./apps/player
COPY apps/spicetify ./apps/spicetify

# Production deps only — skips the electron / esbuild / typescript devDeps.
# ffmpeg-static's postinstall fetches a Linux binary during npm ci.
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates ffmpeg python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g tsx \
    && python3 -m pip install --no-cache-dir yt-dlp

WORKDIR /app

COPY --from=build /app ./

ENV NODE_ENV=production \
    PORT=4876 \
    DATA_DIR=/app/data \
    YT_DLP_PATH=/usr/local/bin/yt-dlp \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    LIBRESPOT_PATH= \
    PLAYER_DIR=/dev/null \
    ELECTRON_PATH=/bin/true

# Linked Spotify tokens, DJ settings, theme, uploads survive restarts.
VOLUME /app/data

CMD ["tsx", "apps/bot/src/index.ts"]
