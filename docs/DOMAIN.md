# Moving Vaporzr to vaporzr.app

Today the bot is served as `https://vaporzr.duckdns.org`:

```
browser / Discord  →  Cloudflare (duckdns is DNS-only)  →  Caddy :443 on the VPS  →  127.0.0.1:4876 (the bot)
```

The `vaporzr.app` zone is already live in Cloudflare (`irma.ns.cloudflare.com`,
`nick.ns.cloudflare.com`) but has **no A record yet**, so nothing points at the
box. This file is the cutover, in order. Steps 1 and 4 are in the Cloudflare and
Discord dashboards; 2 and 3 are on the VPS.

Nothing in the bot needs to change to serve the new name — the origin is the same.
The only code-visible switch is `PUBLIC_BASE_URL` / `JAM_PUBLIC_BASE`, which is
what every generated link (panel, visualizer, listener, jam QR, privacy page)
is built from.

---

## 1. DNS and TLS (Cloudflare dashboard)

Zone → **DNS → Records**, add:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `@` | `46.224.80.104` | **Proxied** (orange) |
| A | `www` | `46.224.80.104` | **Proxied** (orange) |

Then **SSL/TLS → Overview → Full (strict)**. Caddy holds a real Let's Encrypt
certificate for the name, so strict mode validates; "Flexible" would loop.

Leave **Always Use HTTPS** on. Do not enable "Under Attack" — the WebSocket
(`/ws`) that drives the panel and visualizer is long-lived and challenges break it.

Verify from anywhere:

```sh
dig +short vaporzr.app          # Cloudflare anycast IPs
curl -sI https://vaporzr.app/health
```

## 2. Caddy (on the VPS)

`/etc/caddy/Caddyfile` currently has one site block bound to the public IPv4
(the Tailscale interface already holds `:443` for `tailscaled`, hence `bind`):

```caddy
# Vaporzr — public HTTPS endpoint.
vaporzr.duckdns.org, vaporzr.app, www.vaporzr.app {
	bind 46.224.80.104
	encode gzip
	reverse_proxy 127.0.0.1:4876
}
```

```sh
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
journalctl -u caddy -n 30 --no-pager   # "certificate obtained successfully"
```

Keep the duckdns name in the block during the changeover; drop it once the new
name is confirmed working.

## 3. The bot's public origin

`/opt/vaporzr/.env`:

```ini
PUBLIC_BASE_URL=https://vaporzr.app
JAM_PUBLIC_BASE=https://vaporzr.app
```

Restart so the container picks it up:

```sh
cd /opt/vaporzr && docker compose up -d --force-recreate vaporzr
curl -s http://127.0.0.1:4876/health   # expect "publicBase":"https://vaporzr.app"
```

Every link the bot prints should now be branded: `V@panel`, `V@viz`,
`/listen`, the jam QR code, and `V@privacy`. Check one QR by scanning it — it
should read `https://vaporzr.app/jam?invite=…`.

## 4. Discord Developer Portal

**Activities → URL Mapping**: change the root mapping to `https://vaporzr.app/`
(and any `/viz` mapping to `https://vaporzr.app/viz`). The Activity is launched
by Discord into an iframe, so the mapped origin must match what the bot serves.

**General Information**: set

- Privacy Policy URL → `https://vaporzr.app/privacy`
- Terms of Service URL → `https://vaporzr.app/privacy` (or a `/terms` page)

These are the links a server owner checks before adding a bot they don't know.

## 5. Verify the whole path

| Check | Expected |
|---|---|
| `curl -s https://vaporzr.app/health` | `"ok":true`, current `build` |
| `curl -sI https://vaporzr.app/vendor/qrcode.min.js` | `200`, `cf-cache-status` visible |
| `/panel` in a browser | loads, `Secure · Connected` pill turns green (WS over TLS) |
| `/viz` | visuals start, jam QR points at vaporzr.app |
| Activity in Discord | opens on the new mapping, audio pairs as before |
| `V@panel` in Discord | links read `vaporzr.app` |

## Rollback

Revert the two env vars to the duckdns host and recreate the container; DNS and
Caddy can stay as they are. Nothing else in the stack depends on the name.

---

## Optional hardening (all free tiers)

- **WAF → Rate limiting rules**: 60 requests/minute per IP on `/jam` and
  `/api/*`. The jam page is the only unauthenticated surface a stranger can
  hammer, and `SHARE_KEY` protects the rest.
- **Cache rule**: `http.host eq "vaporzr.app" and starts_with(http.request.uri.path, "/vendor/")`
  → Cache eligible, Edge TTL 1 month. The preset pack is a few MB and never
  changes between deploys (the pages request it with a build query).
- **Cloudflare Access** on `/panel` and `/deck` (Zero Trust → Access →
  Applications) if you want a second lock in front of the owner pages. The bot
  already enforces `SHARE_KEY` scope, so Access is belt-and-braces — skip it if
  the double login annoys you.
- **HSTS** (SSL/TLS → Edge Certificates) once the new name has been stable for a
  week. It is hard to undo, so do it last.

## Alternative: a named Cloudflare Tunnel instead of Caddy

If you'd rather not expose the VPS IP at all, a tunnel replaces steps 1–2:

```sh
cloudflared tunnel login
cloudflared tunnel create vaporzr
cloudflared tunnel route dns vaporzr vaporzr.app
cloudflared service install    # systemd, points at 127.0.0.1:4876
```

with `/etc/cloudflared/config.yml`:

```yaml
tunnel: vaporzr
credentials-file: /root/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: vaporzr.app
    service: http://127.0.0.1:4876
  - hostname: www.vaporzr.app
    service: http://127.0.0.1:4876
  - service: http_status:404
```

Then close `80`/`443` in the firewall and stop Caddy. The bot also understands
`TUNNEL_TOKEN` (it will spawn `cloudflared` itself when the binary is at
`CLOUDFLARED_PATH`), but running it as a systemd service is the sturdier option —
a container restart then never drops the public endpoint.
