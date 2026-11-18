/**
 * Vaporzr edge monitor — a Cloudflare Worker on a cron trigger.
 *
 * Why this and not Uptime Kuma: the existing monitor runs on the same host as
 * the bot, so it goes quiet exactly when it matters (power, invoice, OOM). This
 * runs on Cloudflare's edge, needs no server, and is free at this volume
 * (100k requests/day; a 15-minute cron is 96/day).
 *
 * It watches the things that actually broke in practice:
 *   - the host or container being unreachable (`ok` missing / fetch failing)
 *   - no successful off-site backup (`backup.stale`, `backup.error`)
 *   - Spotify/librespot down (silent playback failures)
 *   - YouTube health degraded (the fallback source for every Spotify track)
 *
 * Alerts go to a Discord webhook. Optional KV binding `STATE` suppresses repeats
 * of the same problem for SUPPRESS_MINUTES (default 180) and announces recovery;
 * without the binding it alerts on every run, which is noisy but works.
 *
 * Deploy: see docs/EDGE.md.
 */

const DEFAULTS = {
  HEALTH_URL: 'https://www.vaporzr.app/health',
  SUPPRESS_MINUTES: '180',
};

async function readHealth(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'vaporzr-edge-monitor' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Turn a /health payload into a stable list of problems. */
export function problemsFor(health) {
  const problems = [];
  if (!health || health.ok !== true) {
    problems.push({ key: 'down', text: 'bot health endpoint is not returning ok' });
    return problems;
  }
  const backup = health.backup;
  if (backup) {
    if (backup.error) problems.push({ key: 'backup-error', text: `backup error: ${backup.error}` });
    if (backup.stale) {
      const age = typeof backup.ageHours === 'number' ? `${backup.ageHours}h old` : 'never succeeded';
      problems.push({ key: 'backup-stale', text: `off-site backup is stale (${age})` });
    }
  } else {
    // Older builds do not report backup state; say so rather than implying it is fine.
    problems.push({ key: 'backup-unreported', text: 'build does not report backup state' });
  }
  if (health.librespot && health.librespot !== 'running') {
    problems.push({ key: 'librespot', text: `librespot is ${health.librespot}` });
  }
  if (health.youtube && health.youtube !== 'ok') {
    problems.push({ key: 'youtube', text: `YouTube health is ${health.youtube}` });
  }
  if (health.cookieAgeDays && health.cookieAgeDays > 21) {
    problems.push({ key: 'cookies', text: `YouTube cookies are ${health.cookieAgeDays} days old` });
  }
  return problems;
}

function signature(problems) {
  return problems
    .map((p) => p.key)
    .sort()
    .join(',');
}

async function post(webhook, content) {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 1900) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`discord webhook HTTP ${res.status}`);
}

/** Decide whether this run should speak. Pure, so the behaviour is testable. */
export function decide(problems, previous, nowMs, suppressMinutes) {
  const sig = signature(problems);
  const healthy = problems.length === 0;
  const tooSoon = previous && previous.sig === sig && nowMs - Number(previous.at || 0) < suppressMinutes * 60_000;

  if (healthy) {
    if (previous && previous.sig) {
      return { notify: true, kind: 'recovered', next: { sig: '', at: nowMs } };
    }
    return { notify: false, kind: 'noop', next: { sig: '', at: nowMs } };
  }
  if (tooSoon) return { notify: false, kind: 'suppressed', next: previous };
  return { notify: true, kind: 'alert', next: { sig, at: nowMs } };
}

function message(kind, problems, health) {
  if (kind === 'recovered') return '✅ **Vaporzr**: back to normal.';
  const build = health && health.build ? ` (build \`${health.build}\`)` : '';
  const lines = problems.map((p) => `• ${p.text}`).join('\n');
  return `⚠️ **Vaporzr**${build}\n${lines}`;
}

export default {
  async scheduled(_event, env, ctx) {
    const url = env.HEALTH_URL || DEFAULTS.HEALTH_URL;
    const suppress = Number(env.SUPPRESS_MINUTES || DEFAULTS.SUPPRESS_MINUTES);
    const now = Date.now();

    let health = null;
    let problems;
    try {
      health = await readHealth(url);
      problems = problemsFor(health);
    } catch (err) {
      problems = [{ key: 'down', text: `health check failed: ${err instanceof Error ? err.message : String(err)}` }];
    }

    const previous = env.STATE ? JSON.parse((await env.STATE.get('last')) || 'null') : null;
    const decision = decide(problems, previous, now, suppress);

    if (decision.notify && env.DISCORD_WEBHOOK_URL) {
      await post(env.DISCORD_WEBHOOK_URL, message(decision.kind, problems, health));
    }
    if (env.STATE) ctx.waitUntil(env.STATE.put('last', JSON.stringify(decision.next)));
  },

  // Manual run from a browser or curl; returns the same verdict without alerting.
  async fetch(_request, env) {
    const url = env.HEALTH_URL || DEFAULTS.HEALTH_URL;
    try {
      const health = await readHealth(url);
      const problems = problemsFor(health);
      return Response.json({ ok: problems.length === 0, problems });
    } catch (err) {
      return Response.json(
        { ok: false, problems: [{ key: 'down', text: err instanceof Error ? err.message : String(err) }] },
        { status: 502 },
      );
    }
  },
};
