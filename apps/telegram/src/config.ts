/**
 * Environment for the Telegram front end.
 *
 * Everything here is read once at boot and validated up front: a missing token
 * or key should stop the process with a sentence the operator can act on, not
 * surface later as a 401 on every request.
 */

export interface Config {
  token: string;
  /** Base URL of the running Vaporzr bot (the same one the web panel uses). */
  vaporzrUrl: string;
  /** Control credential: SHARE_KEY or MASTER_PASSWORD. */
  vaporzrKey: string;
  /** Public panel URL for the "Open panel" button; empty disables the button. */
  panelUrl: string;
  /** Long-poll hold, in seconds. Telegram's maximum is 50. */
  pollSeconds: number;
  /** Chat ids allowed to use the bot. Empty means every chat is allowed. */
  allowedChats: Set<number>;
  /** Where the card/offset state lives. */
  statePath: string;
}

function str(value: string | undefined): string {
  return (value ?? '').trim();
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(str(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Parses the environment, throwing one readable error per problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = str(env.TELEGRAM_BOT_TOKEN);
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set (get one from @BotFather).');

  const vaporzrUrl = str(env.VAPORZR_URL) || 'http://127.0.0.1:4876';
  if (!/^https?:\/\//i.test(vaporzrUrl)) {
    throw new Error(`VAPORZR_URL must start with http:// or https:// (got "${vaporzrUrl}").`);
  }

  const vaporzrKey = str(env.VAPORZR_KEY);
  if (!vaporzrKey) {
    throw new Error('VAPORZR_KEY is not set (use the bot SHARE_KEY or MASTER_PASSWORD).');
  }

  const allowedChats = new Set<number>();
  for (const part of str(env.TELEGRAM_ALLOWED_CHATS).split(',')) {
    const id = Number.parseInt(part.trim(), 10);
    if (Number.isFinite(id)) allowedChats.add(id);
  }

  return {
    token,
    vaporzrUrl: vaporzrUrl.replace(/\/+$/, ''),
    vaporzrKey,
    panelUrl: str(env.TELEGRAM_PANEL_URL),
    // Leave headroom under the 50s ceiling so the long poll always returns
    // before the connection is considered dead.
    pollSeconds: Math.min(45, int(env.TELEGRAM_POLL_TIMEOUT, 25)),
    allowedChats,
    statePath: str(env.TELEGRAM_STATE_PATH) || './data/telegram-state.json',
  };
}
