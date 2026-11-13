# White-label domains

A Server-plan customer can serve their panel and share links from their own
hostname instead of `vaporzr.app` — `music.theirdomain.com`, for example.

The bot supports this today. **The edge does not configure itself**: pointing a
new hostname at the box is still a DNS + reverse-proxy step on the operator
side. This page is that checklist.

---

## What the customer does (1 minute)

In the panel, **More → Plan** (Server plan required) or with the API:

```sh
curl -X POST "https://vaporzr.app/api/domain?guildId=<GUILD_ID>" \
  -H "Content-Type: application/json" \
  -H "Cookie: vz_sess=<their session>" \
  -d '{"host":"music.theirdomain.com"}'
```

The host is validated (bare hostname or full URL, no ports, no paths, no
wildcards, no `localhost`/private names) and stored per guild in
`data/domains.json`. `GET /api/domain` returns it; `DELETE /api/domain` removes
it. The response includes a `base` of `https://music.theirdomain.com`.

Once claimed, that host becomes the **default guild** for every API that would
otherwise fall back to the bridge's primary guild, so `https://music.theirdomain.com/api/stats`
answers for that customer's server with no query parameter.

## What the operator does

### 1. DNS

Have the customer point the hostname at the box. Either works:

| Type | Name | Content | Notes |
|---|---|---|---|
| A | `music` | the VPS IPv4 | simplest |
| CNAME | `music` | `vaporzr.app` | only if the target is itself proxied |

If Cloudflare fronts their zone, proxy it (orange cloud) and set **SSL/TLS →
Full (strict)**, exactly as `DOMAIN.md` describes for `vaporzr.app`. Do not
enable "Under Attack": the `/ws` socket is long-lived and challenges break it.

### 2. Reverse proxy

Caddy issues a certificate automatically for any hostname listed in a site
block, so adding the customer is one line:

```caddy
music.theirdomain.com {
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

Doing this for many customers means many site blocks. A wildcard
(`*.customers.theirdomain.com` with a DNS-01 challenge) is the scalable version,
but it requires the customer to use a subdomain *you* control, which defeats the
point for most of them. Site blocks are fine up to a few dozen.

### 3. Verify

```sh
dig +short music.theirdomain.com
curl -sI https://music.theirdomain.com/health
curl -s  https://music.theirdomain.com/api/billing/status | head -c 200
```

The `/health` `build` field should match the currently deployed sha. If it
answers but `publicBase` is wrong, `PUBLIC_BASE_URL` is what generated links
use — that stays the shared name unless the customer also wants *their* domain
in every link.

## Limits worth telling the customer up front

- **One hostname per guild.** Claiming a second replaces the first.
- **The hostname is not a login.** Visitors still need a control key or an
  invite link; the domain only changes the address.
- **Generated links keep using `PUBLIC_BASE_URL`.** A customer whose share links
  must point at *their* name needs the deployment's base URL changed, which
  affects everyone. Per-guild share origins are a separate piece of work.
- **Removing the domain** (`DELETE /api/domain`) does not remove the DNS record
  or the Caddy block. Those are yours to clean up.
