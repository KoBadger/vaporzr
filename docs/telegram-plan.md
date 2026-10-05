# Vaporzr on Telegram — Implementation Plan (Approach B + C)

**Scope:** a Telegram version of the bot that (B) plays audio in a **Mini App (Web App)** on each
user's device and (C) is controlled from **chat** (commands + inline keyboards).

**Explicitly out of scope:** MTProto userbot / `pytgcalls` / shared group-call audio. The Telegram
Bot API cannot join a group call, so that path is not considered here.

**Hard constraint:** the working Discord bot must keep running unchanged throughout. All work is
additive; the refactor is a strangler, never a big-bang.

---

## 1. Why this is feasible

The bot is already ~80% platform-agnostic. The Discord-specific surface is small and well isolated:

| Layer | Files | Ports to Telegram? |
|---|---|---|
| Audio engine | `playback.ts`, `queue.ts`, `crossfade.ts`, `audiofx.ts`, `analyzer.ts` | Reuse (after decoupling `voice`) |
| Resolvers | `spotify.ts`, `youtube.ts`, `soundcloud.ts`, `apple.ts`, `suno.ts`, `deezer.ts`, `mediaDownload.ts` | Reuse as-is |
| Features | `endlesswave.ts`, `smartShuffle.ts`, `vibe.ts`, `games.ts`, `stats.ts`, `playlists.ts`, `lyrics.ts`, `tts.ts`, `images.ts`, `soundboard.ts` | Reuse as-is |
| Shared types | `packages/shared` | Reuse |
| **Transport** | `voice.ts` (Discord UDP/Opus) | **Rewrite** (the only real work) |
| **Interface** | `discord.ts` (commands/components), `bridge.ts`/`server.ts`/`public/*` (web) | Rewrite / adapt |
| Sessions | `session.ts` (guilds), `permissions.ts` | Adapt (guild → chat) |

### The one important discovery

`bridge.ts` **already broadcasts raw 48 kHz stereo PCM over WebSocket** to visualizer clients
(`subscribedPcm` → `broadcastPcm`). A Mini App can subscribe to that same stream and play it with
the Web Audio API. So "audio to Telegram" is not new plumbing — it is the existing PCM fan-out with
a new subscriber.

That gives the clean conceptual mapping:

> **Discord:** engine → Opus → Discord voice UDP
> **Telegram:** engine → raw PCM → WebSocket → Mini App (Web Audio)

---

## 2. Target architecture

```
packages/
  shared/        types (unchanged)
  core/          NEW — platform-agnostic engine (moved from apps/bot/src)
    queue.ts, playback.ts, crossfade.ts, audiofx.ts, analyzer.ts
    spotify.ts, youtube.ts, soundcloud.ts, apple.ts, suno.ts, deezer.ts, mediaDownload.ts
    endlesswave.ts, smartShuffle.ts, vibe.ts, games.ts, stats.ts, playlists.ts,
    lyrics.ts, tts.ts, images.ts, soundboard.ts, config.ts
    transport.ts        <-- the AudioTransport interface (section 3)
apps/
  bot/           Discord adapter (unchanged behaviour)
    voice.ts (implements AudioTransport), discord.ts, bridge.ts, server.ts,
    session.ts, permissions.ts, panelIcons.ts, tunnel.ts, public/*
  telegram/      NEW
    src/index.ts        grammY bot bootstrap
    src/commands.ts     chat control (section 5)
    src/sessions.ts     chat -> Session map (mirrors SessionManager)
    src/webtransport.ts AudioTransport that fans PCM out to Mini App sockets
    src/initData.ts     Telegram Web App initData validation
    src/miniapp/        Mini App front-end (reuses panel.html/viz.html)
```

The engine never imports `voice.ts`. Instead it depends on `AudioTransport`.

---

## 3. The `AudioTransport` interface (the keystone)

Derived from every `this.voice.*` call in `playback.ts` (51 call sites, ~20 distinct methods):

```ts
// packages/core/src/transport.ts
export interface AudioTransport {
  // lifecycle / state
  isJoined(): boolean;
  isStalled(): boolean;
  isRawFeedActive(): boolean;
  getPositionMs(): number;
  cancelIdleLeave(): void;

  // playback (server-side streams)
  playFfmpegUrl(url: string, opts: {
    seekMs?: number; volume?: number; durationMs?: number; retries?: number;
    refreshUrl?: () => Promise<string>; onEnd?: () => void;
  }): void;
  stopStream(): void;

  // raw PCM feed (Spotify / librespot path)
  startStream(): void;
  feedPcm(data: Buffer): boolean;
  setStreamDrain(fn: (() => void) | null): void;
  setExpectingPcm(expected: boolean): void;

  // effects / mixing
  setAudioFx(fx: string): void;
  setVolume(v: number): void;
  setStreamOffset(ms: number): void;
  queueSfxPcm(pcm: Buffer): void;
  suppressCurrentTailFade(ms: number): void;
  decodeHeadPcm(url: string, ms: number, tempo?: number): Promise<Buffer | null>;

  // callbacks / taps
  setOnVoiceReconnect(cb: () => void): void;
  setStallRecovery(cb: () => void): void;
  setSpectrumTap(fn: ((data: Buffer) => void) | null): void;

  // pause/resume
  pause(): void;
  resume(): void;
}
```

- `apps/bot/src/voice.ts` already implements all of these — add `implements AudioTransport`, no
  behaviour change.
- `apps/telegram/src/webtransport.ts` implements the same surface, but instead of encoding to Opus
  it forwards the mixed PCM to the session's Mini App sockets (and uses a no-op/short-circuit for
  Discord-only concerns like `isJoined()` → "is a Mini App subscribed").

`PlaybackController` changes from `private voice: VoiceManager` to `private voice: AudioTransport`.
That is the single, small change that unlocks both platforms.

---

## 4. Strangler extraction (keep Discord working)

Do it in this order; after **every** step run `npx tsc --noEmit` + `npx vitest run` (currently
323 tests) and deploy.

1. **Interface first (no file moves).** Add `transport.ts`; make `PlaybackController` depend on the
   interface; add `implements AudioTransport` to `VoiceManager`. Verify: identical behaviour, all
   tests green. *(This alone is a safe, shippable commit.)*
2. **Move pure modules** into `packages/core`, one group per commit (resolvers → features → engine),
   fixing imports. These modules have no Discord imports, so moves are mechanical. The bot's imports
   become `@vaporzr/core/...`.
3. **Leave Discord-coupled modules in `apps/bot`** (`voice.ts`, `discord.ts`, `bridge.ts`,
   `server.ts`, `session.ts`, `permissions.ts`, `tunnel.ts`, `panelIcons.ts`).
4. Only after the engine builds from `packages/core` do we start `apps/telegram`.

Guardrail: if step 2 proves noisy, an interim shortcut is to add an `exports` subpath to
`apps/bot/package.json` (`"./core/*": "./src/*"`) so Telegram can reuse the engine **without** moving
files, then extract to `packages/core` later. Prefer the real extraction, but the shortcut keeps
momentum if time-boxed.

---

## 5. `apps/telegram` — chat control (C)

**Library: [grammY](https://grammy.dev).** TypeScript-first, first-class Web App / `initData`
helpers, clean middleware, actively maintained (telegraf is fine but weaker on TS + Web Apps).

Command mapping (Discord → Telegram):

| Discord | Telegram |
|---|---|
| `/play` `V@p` | `/play <query\|url>` + inline results keyboard |
| `/skip` `/previous` | `/skip` `/prev` |
| `/queue` | `/queue` (paginated inline keyboard) |
| `/shuffle smart\|arc\|key` | `/shuffle smart\|arc\|key` |
| `/autoplay off\|basic\|smart` | `/autoplay …` |
| `/nowplaying` | `/np` (+ Mini App button) |
| embeds | Markdown/HTML message + `InlineKeyboard` |
| components/buttons | `InlineKeyboard` callback data |
| Activities / web panel | **Mini App** (`web_app` button) |

Deliver audio in chat (option C) by sending rendered files where a file makes sense (mashups,
playlists, lyrics cards); live listening is the Mini App's job.

Sessions: `apps/telegram/src/sessions.ts` mirrors `SessionManager`, keyed by Telegram chat id
instead of guild id. Reuse `QueueManager` + `PlaybackController` + `WebTransport` per chat. A single
shared `librespot` (Spotify backend) can back all chats, exactly as it backs all guilds today.

Persistence: reuse `session.ts`'s queue persistence shape, keyed by chat id
(`data/queues/tg-<chatId>.json`).

---

## 6. Mini App (B)

Reuse `public/panel.html` and `public/viz.html` almost verbatim — they already speak the WS bridge
protocol. Changes:

1. **Auth.** Telegram Web Apps pass `initData` (signed by the bot token). Validate it **server-side**
   with HMAC-SHA256 over the data-check-string (`secret = HMAC_SHA256("WebAppData", bot_token)`),
   checking `auth_date` freshness. Add a `POST /telegram/auth` that exchanges `initData` for the
   same session cookie the panel uses today. Guests without a valid signature stay read-only
   (reuse the existing guest path in `bridge.ts`).
2. **Audio.** Add a Mini App subscription that receives PCM frames (reuse `broadcastPcm`) and plays
   them via `AudioContext` (schedule buffers on a small ring, ~150–300 ms jitter buffer). The
   visualizer already consumes this exact stream, so the code path exists.
3. **Transport.** `webtransport.ts` routes each session's mixed PCM to the sockets subscribed to
   that chat, instead of `VoiceManager`'s Opus encoder. `playFfmpegUrl` and the raw-feed path both
   end at the same `feedPcm`-style sink.
4. **Server.** `server.ts`/`bridge.ts` gain a Telegram auth route and a per-chat PCM room. Keep the
   existing Discord panel behaviour untouched (additive routing).

Sync note: this is "near-synchronous" listening (each client buffers independently); it is not a
sample-locked shared call, which is acceptable for B+C.

---

## 7. Phasing (each independently shippable)

| Phase | Deliverable | "Done" check |
|---|---|---|
| **0. Transport interface** | `AudioTransport` + `VoiceManager implements` + `PlaybackController` depends on it | tsc clean, 323 tests pass, Discord bot unchanged |
| **1. `packages/core`** | pure modules moved; bot imports `@vaporzr/core/*` | tsc + tests green; Discord bot deployed and playing |
| **2. Telegram skeleton** | grammY bot, `/start` `/help` `/queue` `/np` (text only) | bot responds in a real Telegram chat |
| **3. Chat control** | `/play`, `/skip`, `/shuffle`, `/autoplay`, `/mashup`, playlists, stats; inline keyboards | a queue can be built and driven from Telegram |
| **4. Mini App audio** | `initData` auth + PCM subscription + Web Audio playback | a user opens the Mini App and hears the queue |
| **5. Polish** | per-chat sessions + persistence, rate limits, permissions, deploy (Docker + workflow) | second Telegram chat runs an independent queue |

---

## 8. Top risks

1. **Mini App audio latency/jitter** — WS + Web Audio needs a jitter buffer; may drift. Mitigate with
   a 200–300 ms buffer and periodic resync; accept it is not sample-locked.
2. **`initData` auth mistakes** — a wrong HMAC lets anyone join. Mitigate with a strict validator +
   unit tests, and keep unsigned users read-only.
3. **Engine extraction churn** — moving 30 files can break imports. Mitigate with the strangler order
   in section 4 and the `exports`-subpath fallback.
4. **Spotify/librespot sharing across chats** — one backend, many consumers; today it serves many
   guilds, so this is proven, but PCM fan-out to N chats costs CPU. Mitigate by capping concurrent
   Mini App listeners or downsampling for non-primary chats.
5. **Telegram file/stream limits** — Bot API upload 50 MB / download 20 MB. Mitigate: render short
   mashup clips (already 90 s), or run a local Bot API server if large files are needed.

---

## 9. Effort estimate

| Phase | Estimate |
|---|---|
| 0. Transport interface | 1–2 days |
| 1. `packages/core` | 3–5 days |
| 2. Telegram skeleton | 1–2 days |
| 3. Chat control (core commands) | 3–5 days |
| 4. Mini App audio | 4–6 days |
| 5. Polish + deploy | 2–3 days |
| **Total** | **~3–4 weeks** (part-time), core commands usable after ~1 week |

---

## 10. Immediate next step

Do **Phase 0** now: add `packages/core/src/transport.ts`, make `PlaybackController` depend on it, and
mark `VoiceManager` as implementing it. It is small, safe, and verifiable, and it is the gate that
makes everything else additive.
