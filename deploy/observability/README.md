# Observability stack (optional, free/self-hosted)

These are **add-ons** for the VPS, not part of the bot image. They make uptime,
resource use, logs and crashes visible instead of anecdotal. Run them next to
the existing `vaporzr` container, ideally bound to a private interface or behind
the same reverse proxy.

| Tool | What it answers | Port |
|---|---|---|
| [Uptime Kuma](https://github.com/louislam/uptime-kuma) | Is `/health` up? Alert me when it is not | 3001 |
| [Dozzle](https://github.com/amir20/dozzle) | Live `docker logs vaporzr` in a browser | 8081 |
| [Beszel](https://github.com/henrygd/beszel) | CPU/RAM/disk history for the VPS and containers | 8090 |
| [Umami](https://github.com/umami-software/umami) | Privacy-friendly page views for the portal | 3000 |
| [GlitchTip](https://glitchtip.com/) | Error tracking (Sentry-compatible) for the bot | 8000 |

## Quick start

```sh
mkdir -p /opt/observability && cd /opt/observability
# copy compose.yml next to this README, then:
docker compose up -d
```

Set strong credentials in `.env` first — never leave the defaults exposed:

```sh
UMAMI_DB_PASSWORD=$(openssl rand -hex 24)
UMAMI_APP_SECRET=$(openssl rand -hex 32)
```

## Wiring

- **Uptime Kuma:** add an HTTP(s) monitor for `http://127.0.0.1:4876/health`
  (from inside the host) or `https://<your-domain>/health`; expect JSON with
  `"ok": true`. Add a Discord/ntfy/email notification.
- **Dozzle:** point the browser at `http://<vps>:8081`, or reverse-proxy it with
  basic auth. It only reads logs; it cannot control containers by default.
- **Beszel:** create a system, then install the agent in the compose file. Add
  an alert for sustained CPU > 90% or disk > 85%.
- **Umami:** add `/` and `/status` as websites. The portal has no tracking
  scripts; Umami's own snippet is only needed if you want page-view analytics.
- **GlitchTip:** for the bot, the simplest integration is a small wrapper that
  forwards `unhandledRejection`/`uncaughtException` to GlitchTip's DSN; otherwise
  use Dozzle for log-level visibility first.

## Security

- Bind these ports to `127.0.0.1` when possible and use an SSH tunnel:
  `ssh -N -L 3001:127.0.0.1:3001 user@vps`.
- Do not expose the Docker socket to the internet. Dozzle and Beszel mount it
  read-only; keep their ports private.
- Uptime Kuma and Umami have their own login systems — set them up on first run
  and disable public registration.
