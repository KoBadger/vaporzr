/**
 * Gateway liveness, summarised for /health.
 *
 * On 2026-11-22 the bot ran for ten hours, answered /health with `guilds: 11`,
 * and silently ignored every command for a stretch in the middle of that run.
 * Nothing in /health described the connection itself: `guilds` and `sessions`
 * are guild-cache and session-map sizes, both of which survive a dead socket, so
 * every probe read green. These counters exist so the next occurrence can be
 * answered from outside the process — the container's own logs are deleted by
 * the deploy that follows it.
 */

/** discord.js `client.ws.status`, in order. */
const STATUS_NAMES = ['ready', 'connecting', 'reconnecting', 'idle', 'nearly', 'disconnected'] as const;

export function gatewayStatusName(code: number): string {
  return STATUS_NAMES[code] ?? `unknown(${code})`;
}

export interface GatewayCounters {
  /** discord.js `client.ws.status`. */
  wsStatus: number;
  /** discord.js `client.ws.ping`, ms (-1 until the first heartbeat ACK). */
  pingMs: number;
  /** `client.isReady()` — the guild cache is populated and dispatches flow. */
  ready: boolean;
  /** When this session last reached READY; 0 means "never since boot". */
  readyAt: number;
  disconnects: number;
  disconnectTimes: number[];
  resumes: number;
  /** Last dispatch of any kind (message, typing, presence, …). */
  lastEventAt: number;
  messagesSeen: number;
  lastMessageAt: number;
  /** MESSAGE_CREATE from a human with an empty body, i.e. withheld content. */
  emptyContentMessages: number;
}

export interface GatewayHealth {
  status: string;
  ready: boolean;
  pingMs: number;
  /** Seconds since this session reached READY, or null if it never has. */
  sessionAgeSec: number | null;
  disconnects: number;
  disconnectsLastHour: number;
  resumes: number;
  /** Seconds since any gateway dispatch arrived, or null since boot. */
  lastEventAgoSec: number | null;
  messagesSeen: number;
  lastMessageAgoSec: number | null;
  emptyContentMessages: number;
}

const HOUR_MS = 3_600_000;

/**
 * True when no gateway dispatch has arrived for `maxSilenceMs`. A zombie socket
 * keeps heartbeating — ws.status stays READY and ping looks fine — while every
 * command is silently dropped. That exact failure ran for two days in Nov 2026
 * because nothing compared event arrival against the clock.
 */
export function gatewayGoneSilent(lastEventAt: number, now: number, maxSilenceMs: number): boolean {
  return lastEventAt > 0 && now - lastEventAt >= maxSilenceMs;
}

export function gatewayHealth(c: GatewayCounters, now: number = Date.now()): GatewayHealth {
  const ageSec = (at: number): number | null => (at > 0 ? Math.max(0, Math.round((now - at) / 1000)) : null);
  return {
    status: gatewayStatusName(c.wsStatus),
    ready: c.ready,
    pingMs: Math.round(c.pingMs),
    sessionAgeSec: ageSec(c.readyAt),
    disconnects: c.disconnects,
    disconnectsLastHour: c.disconnectTimes.filter((t) => now - t < HOUR_MS && t <= now).length,
    resumes: c.resumes,
    lastEventAgoSec: ageSec(c.lastEventAt),
    messagesSeen: c.messagesSeen,
    lastMessageAgoSec: ageSec(c.lastMessageAt),
    emptyContentMessages: c.emptyContentMessages,
  };
}
