# Edge: what fronts the bot, and how to stop paying for a second door

## What is actually running (measured 2026-11-17)

```
Internet ──► Cloudflare (proxied DNS) ──► Caddy :443 on 46.224.80.104 ──► 127.0.0.1:4876
Internet ──► Tailscale Funnel (vaporzr3-1.tail137f17.ts.net) ───────────► 127.0.0.1:4876
```

- **Caddy** (`/etc/caddy/Caddyfile`) serves `vaporzr.app`, `www.vaporzr.app` and
  `vaporzr.duckdns.org`. `WEB_ACCESS` is unset, so the app accepts public hosts;
  the panel's own session/key auth is the gate.
- **Tailscale** is used for two things: **Funnel**, which publishes the same app
  at a `.ts.net` URL, and a tailnet-only reverse proxy for the OpenCode app on
  `:4100`.

Funnel is a *second public door* to the same panel. It adds no reachability that
`www.vaporzr.app` does not already have, so cancelling Tailscale costs the
`.ts.net` URL and the dev proxy — not access.

## Retiring Tailscale

On the VPS:

```sh
tailscale funnel reset        # stop publishing the app to the internet
tailscale serve reset         # ALSO removes the :4100 OpenCode proxy
tailscale down                # drop the tailnet for now (reversible)
```

`serve reset` is listed separately because it is the one with a side effect: the
OpenCode proxy disappears with it. If you still want that, replace it with an SSH
forward you already use for the panel:

```sh
ssh -N -L 4100:127.0.0.1:4096 root@46.224.80.104
```

Only cancel the Tailscale subscription after a week of not missing either URL.

## Cloudflare Access (the part that is worth money)

Access puts an identity check in front of selected paths, free for up to 50 users.
The origin keeps its own auth; Access removes drive-by traffic and gives you a
login you can revoke.

1. https://one.dash.cloudflare.com → **Access → Applications → Add an application
   → Self-hosted**.
2. Application domain: `www.vaporzr.app`, path **`panel`**.
3. Policy: **Allow**, action *Allow*, include **Emails** = your address (add
   anyone who should reach the panel). Login method: One-time PIN (no setup) or
   Google.
4. Repeat for path **`viz`** once `panel` is confirmed working.

**Do not gate these** — they serve people who have no Cloudflare session:

| Path | Why |
| --- | --- |
| `/activity*` | Discord Activity iframe; a login redirect inside Discord's client cannot complete |
| `/j/*` | Jam invites for guests |
| `/health` | Uptime monitors and the edge worker |
| `/`, static assets | Public landing page |

Widen the protected list only after checking the Activity and a jam link still
work: `/upgrade`, then specific `/api/` prefixes. Gating all of `/api/*` at once
will break the Activity's guest handshake.

## WAF rate limit

https://dash.cloudflare.com → your zone → **Security → WAF → Rate limiting rules**
→ Create:

- If incoming requests match `http.request.uri.path matches "^/api/"` (or use
  *Edit expression*)
- Rate: **60 requests per 1 minute**, per IP
- Action: **Block**, duration 1 minute

Free plans include a small rule allowance; one rule is enough for the abusive
case. This is belt and braces next to the per-endpoint `burst()` limits already in
`apps/bot/src/server.ts`.

## Edge monitor (replaces Uptime Kuma on a box that can die)

`deploy/cloudflare/monitor-worker.mjs` runs on a cron trigger, reads `/health`,
and posts to Discord when something is wrong — including `backup.stale`, which is
the check whose absence let five weeks of failed backups pass unnoticed.

Why not keep Uptime Kuma: it runs on the monitored host. It cannot report a dead
box, a suspended invoice or a wedged container, which are the failures that
actually happened.

### Deploy

```sh
npm install -g wrangler
wrangler login

cd deploy/cloudflare
cp wrangler.toml.example wrangler.toml
# optional dedupe state:
wrangler kv namespace create VZR_MONITOR      # paste the id into wrangler.toml

wrangler secret put DISCORD_WEBHOOK_URL
#   Server Settings → Integrations → Webhooks → New Webhook → Copy URL

wrangler deploy
```

`wrangler deploy` registers the cron from `wrangler.toml` (`*/15 * * * *`). Check
it: Workers & Pages → `vaporzr-monitor` → **Triggers**, and **Logs → Live**.

Without the KV binding the worker still works; it just re-alerts every 15 minutes
while the problem persists instead of suppressing repeats.

### What it alerts on

| Condition | Why it matters |
| --- | --- |
| `/health` unreachable or `ok` false | The failure that took the bot down |
| `backup.stale` / `backup.error` | No off-site copy, or the last push failed |
| `librespot != running` | Spotify playback will silently fall back or stop |
| `youtube != ok` | The fallback source for every Spotify track |
| `cookieAgeDays > 21` | Cookie expiry is what kills YouTube extraction |

Recovery is announced once, so silence afterwards means silence, not "still down".

### Test it locally

```sh
npm run test:worker        # from the repo root
```

## Optional: close the origin (no open 80/443)

Caddy currently answers on the public IP, so anyone who learns the address can
bypass Cloudflare (and therefore Access). The stronger shape is a tunnel:

1. Zero Trust → **Networks → Tunnels → Create a tunnel** (cloudflared).
2. Public hostname `www.vaporzr.app` → service `http://127.0.0.1:4876`.
3. On the VPS:

   ```sh
   docker run -d --name cloudflared --restart unless-stopped --network host \
     cloudflare/cloudflared:latest tunnel --no-autoupdate run --token <TOKEN>
   ```

4. Point the Cloudflare DNS record at the tunnel (the dashboard does this for
   you), verify the panel and `/health`, **then** close the ports:

   ```sh
   ufw allow 22/tcp && ufw enable        # keep SSH reachable
   systemctl stop caddy && systemctl disable caddy
   ```

Do this only after the tunnel hostname is verified end to end — otherwise you lose
the only ingress. `WEB_ACCESS` can stay unset: the app is still reached over
loopback by the connector, and `clientIp()` already trusts `CF-Connecting-IP`
when the socket is loopback.
