/**
 * Telegram's privacy mode decides what a bot is allowed to see in a group, and
 * that decision drives the entire input model. Getting it wrong is invisible
 * from our side — the message simply never arrives — so the rules live here, in
 * one pure function, rather than being re-derived at each call site.
 *
 * What Telegram guarantees (core.telegram.org/bots/features#privacy-mode):
 *   - private chats: every message arrives, always;
 *   - groups with privacy mode ON: only commands, inline results, replies to the
 *     bot's own messages, and messages that @mention it;
 *   - bot added as a group ADMIN: every message arrives, privacy mode or not;
 *   - channels where the bot is a member: every channel post arrives.
 *
 * So "just type a song name" works in DMs unconditionally, and in a group only
 * after the bot is promoted to admin (or privacy mode is disabled in BotFather,
 * which requires removing and re-adding the bot). `@bot <song>` and replying to
 * the now-playing card work in every group either way — that is the workaround
 * this module routes to instead of asking the owner to change settings.
 */

export type ChatKind = 'private' | 'group' | 'supergroup' | 'channel';

export interface IncomingText {
  chatType: ChatKind;
  text?: string;
  /** The message replies to a message this bot sent. */
  replyToBot: boolean;
  /** This bot's own username without the leading @. Empty when unknown yet. */
  botUsername: string;
}

export type Routed =
  | { kind: 'command'; command: string; args: string }
  | { kind: 'request'; text: string }
  | { kind: 'ignore'; why: 'empty' | 'channel' | 'privacy' | 'other-bot' };

export function isGroupChat(chatType: ChatKind): boolean {
  return chatType === 'group' || chatType === 'supergroup';
}

/**
 * Split `/play@SomeBot a song` into its command and argument text.
 *
 * Returns null when the text is not a command, and `other-bot` when it is a
 * command addressed to a different bot in the same group — those arrive because
 * of the "all commands" delivery rule and must not be answered by us.
 */
export function parseCommand(
  text: string,
  botUsername: string,
): { command: string; args: string } | { otherBot: true } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const space = trimmed.search(/\s/);
  const head = (space === -1 ? trimmed : trimmed.slice(0, space)).slice(1);
  const args = space === -1 ? '' : trimmed.slice(space).trim();
  if (!head) return null;
  const at = head.indexOf('@');
  const name = (at === -1 ? head : head.slice(0, at)).toLowerCase();
  if (at !== -1) {
    const target = head.slice(at + 1).toLowerCase();
    if (botUsername && target !== botUsername.toLowerCase()) return { otherBot: true };
  }
  if (!/^[a-z0-9_]{1,32}$/.test(name)) return null;
  return { command: name, args };
}

/** Remove a leading or inline `@bot` mention, leaving the song text behind. */
export function stripBotMention(text: string, botUsername: string): string {
  if (!botUsername) return text.trim();
  const needle = `@${botUsername}`.toLowerCase();
  const lower = text.toLowerCase();
  let out = text;
  let at = lower.indexOf(needle);
  // A mention can wrap the message ("@bot play x") or sit inside it ("play x
  // @bot"). Both mean "this is for the bot", so drop every occurrence.
  while (at !== -1) {
    out = out.slice(0, at) + out.slice(at + needle.length);
    at = out.toLowerCase().indexOf(needle);
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function mentionsBot(text: string, botUsername: string): boolean {
  if (!botUsername) return false;
  return text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
}

/** Decide what a delivered message means. Pure: no network, no state. */
export function routeText(input: IncomingText): Routed {
  const raw = (input.text ?? '').trim();
  if (!raw) return { kind: 'ignore', why: 'empty' };
  if (input.chatType === 'channel') return { kind: 'ignore', why: 'channel' };

  const parsed = parseCommand(raw, input.botUsername);
  if (parsed) {
    if ('otherBot' in parsed) return { kind: 'ignore', why: 'other-bot' };
    return { kind: 'command', command: parsed.command, args: parsed.args };
  }

  if (input.chatType === 'private') return { kind: 'request', text: raw };

  // Group/supergroup. Under privacy mode these are exactly the deliveries we
  // are guaranteed to get; anything else means the chat is open (admin or
  // privacy mode off) and is handled by the caller via `provesOpenChat`.
  if (input.replyToBot) return { kind: 'request', text: raw };
  if (mentionsBot(raw, input.botUsername)) {
    return { kind: 'request', text: stripBotMention(raw, input.botUsername) };
  }
  return { kind: 'ignore', why: 'privacy' };
}

/**
 * True when a delivered group message could only have reached us because the
 * bot sees everything — i.e. it is an admin, or privacy mode is off in
 * BotFather. Commands, replies and mentions arrive in *both* modes, so they
 * prove nothing.
 */
export function provesOpenChat(input: IncomingText): boolean {
  const raw = (input.text ?? '').trim();
  if (!isGroupChat(input.chatType) || !raw) return false;
  if (input.replyToBot) return false;
  if (parseCommand(raw, input.botUsername)) return false;
  return !mentionsBot(raw, input.botUsername);
}

/** One-line explanation of what works in a group that has not proven itself open. */
export function privacyHint(): string {
  return (
    'In this group I only receive commands, replies to my messages, and messages that @mention me. ' +
    'Any of these work right now:\n' +
    '• <code>/play song name</code>\n' +
    '• reply to the now-playing card with a song name\n' +
    '• <code>@me song name</code>\n\n' +
    'For plain typing with no prefix, either promote me to admin ' +
    '(Group → Administrators → Add Admin) or turn off privacy mode in @BotFather. ' +
    'Promoting is instant; the BotFather toggle only applies after I am removed and re-added.'
  );
}
