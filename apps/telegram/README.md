# @vaporzr/telegram

A Telegram front end for Vaporzr.

It is **not** a second bot with its own queue. It is a control client for the
running Discord bot, using the same HTTP endpoints and WebSocket bridge the web
panel uses. One queue, one voice session, two front ends — and this process can
be restarted without interrupting the music.

## What it does

| Command | Effect |
|---|---|
| `/play <song or link>` | queue something (honours the jam policy: approval, cooldown, per-guest cap) |
| `/queue` | what is up next |
| `/now` | post / refresh the now-playing card |
| `/skip`, `/pause`, `/resume` | the usual |
| `/help`, `/id` | usage; the chat id (for `TELEGRAM_ALLOWED_CHATS`) |

Plain text works in DMs. The now-playing card carries inline buttons: pause /
resume, skip, queue, refresh, and ✖ to remove one of the next three tracks.
Buttons address tracks by hash and the remove is sent as a URI, so a tap always
removes the track it named even if the queue shifted underneath it.

## Setup

1. Talk to [@BotFather](https://t.me/BotFather), `/newbot`, and copy the token.
2. Copy the example env and fill it in:

   ```sh
   cp apps/telegram/.env.example apps/telegram/.env
   ```

   `VAPORZR_KEY` is the bot's `SHARE_KEY` (or `MASTER_PASSWORD`).

3. Run it:

   ```sh
   npm run dev:telegram
   ```

   Or in the image next to the bot:

   ```sh
   docker build -f apps/bot/Dockerfile -t vaporzr-bot .
   docker run -d --name vaporzr-telegram --network host \
     --env-file apps/telegram/.env \
     -e TELEGRAM_STATE_PATH=/app/data/telegram-state.json \
     -v vaporzr-telegram:/app/data \
     vaporzr-bot tsx apps/telegram/src/main.ts
   ```

   `--network host` is what lets the default `VAPORZR_URL=http://127.0.0.1:4876`
   reach the bot container's published loopback port. It also means no extra
   inbound port exists; this process only makes outbound calls.

## Privacy mode: why plain typing sometimes does nothing

Telegram bots in groups are private by default. With privacy mode **on**, a bot
only receives commands, replies to its own messages, inline results sent
through it, and messages that `@mention` it.

So in a group, these always work:

- `/play song name`
- replying to the now-playing card with a song name
- `@yourbot song name`

Plain typing with no prefix only arrives when the bot is a **group admin**, or
when privacy mode has been disabled in BotFather. Promoting the bot is instant;
the BotFather toggle only takes effect after the bot is removed and re-added.
The bot detects which situation it is in: an unaddressed group message can only
have arrived in an open chat, so it remembers that and stops nagging. When it is
not open, the first ignored message gets a one-time explanation instead of
silence.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — (required) | token from BotFather |
| `VAPORZR_KEY` | — (required) | bot `SHARE_KEY` or `MASTER_PASSWORD` |
| `VAPORZR_URL` | `http://127.0.0.1:4876` | the running bot |
| `TELEGRAM_PANEL_URL` | empty | HTTPS panel URL; adds a "Open panel" button and the Web App menu button |
| `TELEGRAM_ALLOWED_CHATS` | empty (all) | comma-separated chat ids allowed to use the bot |
| `TELEGRAM_POLL_TIMEOUT` | `25` | long-poll seconds (capped at 45) |
| `TELEGRAM_STATE_PATH` | `./data/telegram-state.json` | update offset + one card id per chat |

## Server-side contract

Two small changes in the bot make this work, and both are deliberate:

- `hasRequestAccess` accepts a **control** credential. Without it, `SHARE_KEY`
  could drive the panel but not the jam/request endpoints, so the owner's own
  front end would be treated as an anonymous guest.
- `requestGate` skips the per-IP guest budget for control traffic. A single
  Telegram process sends every chat's requests from one IP, so an 8/minute
  guest budget would either throttle a whole group or let one guest spend the
  bot's allowance.

## What it cannot do

Telegram bots cannot join voice chats. Playback stays in Discord voice; this
front end controls the queue and transport. Real audio *in* a Telegram voice
chat needs a userbot over MTProto, which is a different architecture with its
own account-safety trade-offs.

## Tests

```sh
npm test -w @vaporzr/telegram
```

The suite pins the two things that are visible to every user at once: the
privacy router (what a delivered message means) and the card renderer (layout,
clipping, callback-data size, button→track resolution).
