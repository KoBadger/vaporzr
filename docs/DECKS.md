# Live Decks — operator's guide

A two-deck DJ mixer that runs entirely on the bot. Both decks decode server-side
and are summed into the single Opus stream that goes to your voice channel, so
listeners hear the mix exactly as you build it. Cues, loops, EQ, beat-lock and
recording all happen on the bot — nothing is rendered offline.

Open it at **`/deck`** on your panel host (e.g. `https://vaporzr.duckdns.org/deck`).
It needs **control** scope (the same key as `/panel`) and the `deck` permission,
which defaults to **mod**.

---

## 1. Before you mix

1. Get the bot into a voice channel: `V@j`, or start any track with `V@play …`.
2. Load **A** and **B** — paste a song name, a Spotify/YouTube link, or a direct
   audio URL into each deck's box and hit **Load**. The track downloads to disk
   once (that is what makes cueing instant) and the BPM is detected in the
   background.
3. Hit **Play both** (or `space`).

Loading a deck **takes over the stream**: the queue pauses, keeps its cursor, and
resumes where it left off with `V@r` when you stop the decks.

---

## 2. The deck page

Each deck card has, top to bottom:

| Control | What it does |
|---|---|
| Waveform | Decoded peaks. Click anywhere to seek. Amber lines are cue pads, cyan band is the loop |
| Seek bar | Same as the waveform, finer target |
| Load | Resolve + download + cue |
| Play / Cue | Transport, or reset to 0:00 |
| Low / Mid / High + Kill | 3-band EQ, −40 dB … +6 dB; kill buttons slam a band out |
| Trim | Per-deck gain |
| Speed | atempo, pitch preserved (92–108 %) |
| Nudge ±25 ms | Manual phase correction |
| 8 cue pads | Click empty = set at playhead, click set = jump, right-click = clear |
| Loop 1 / 4 / 8 / 16 · Off | Beat-quantised loop, cached as PCM so the wrap is seamless |

Header: **SYNC**, **Lock**, **Record**, **Play both**, **Pause**, **Stop decks**.
Bottom: crossfader, FX bank, MIDI status.

---

## 3. A real transition, start to finish

1. **Load** the outgoing track on A, the incoming one on B. Both show BPM.
2. **Play A**, bring the fader fully left.
3. **Play B** while the fader is still left — nobody hears it yet.
4. **SYNC** → B is stretched to A's tempo (±10 % only; wider gaps are refused)
   and its downbeat is aligned.
5. **Lock** → the bot keeps measuring phase every 400 ms and nudges B by
   ±0.8 % resample, so the two stay glued without any gap.
6. Walk the **crossfader** over 8–16 bars. Classic move: kill **low** on A while
   bringing B in, then swap the lows.
7. Once B is the loudest thing in the mix, **Cue** A, load the next track, repeat.

Tips that actually matter through Discord:

- Beat-match is done by the bot; you make the *musical* choices (phrasing, EQ,
  when the drop lands). Trying to hand-beatmatch by ear is unreliable because
  Discord adds 150–400 ms of jitter buffer.
- Use **loops** to buy time: loop 4 beats on A, load the next track on B, then
  release the loop on the phrase.
- **Cue pads** are for drops and breaks, not just the intro: set one on the first
  beat of a chorus, jump to it at the right moment.

---

## 4. FX bank

Eight pads above the fader: `riser`, `reverse`, `drop`, `boom`, `zap`, `airhorn`,
`applause`, `countdown`. They come from the bot's soundboard and are mixed over
the deck output, so they work mid-mix without interrupting playback.

Keys: `q w e r t y u i` fire them in order.

---

## 5. Keyboard

| Key | Action |
|---|---|
| `space` | Play / pause both decks |
| `←` `→` | Crossfader by 4 % |
| `1`–`8` | Cue pad on deck A (sets if empty, jumps if set) |
| `shift`+`1`–`8` | Same on deck B |
| `q w e r t y u i` | FX pads |

---

## 6. MIDI

Plug in any class-compliant controller (nothing to configure). Default mapping:

| Control | Target |
|---|---|
| CC 1 | Crossfader |
| CC 2 / CC 3 | Trim A / B |
| CC 4–6 | EQ A: low, mid, high |
| CC 7–9 | EQ B: low, mid, high |
| Note 36–43 | FX pads 1–8 |
| Note 48–55 | Cue pads 1–8 on deck A |

The status line under the FX pads shows the device it bound to. Re-plugging
rebinds automatically.

---

## 7. Recording the set

Hit **Record** (or `V@deck rec`). The master mix — both decks, fader, EQ, FX — is
captured to disk as raw PCM and encoded to mp3 when you stop (`V@deck rec stop`).
It then posts to your panel channel; sets over Discord's upload cap stay on the
server and the message gives you the path.

---

## 8. Discord / phone commands

```
V@deck                     status: both decks, BPM, cues, loop, lock drift, recording
V@deck a <song|link>       load deck A          V@deck b <song|link>   load deck B
V@deck play | pause | stop
V@deck sync                beat-match B → A
V@deck lock                keep them locked (lock off to release)
V@deck pad a 3             set/jump hot cue 3
V@deck loop a 4            loop 4 beats        V@deck loop a off
V@deck seek a 1:30         jump
V@deck nudge a 25          ±ms phase nudge
V@deck cross 60            0 = A, 100 = B
V@deck gain a 85           trim %
V@deck eq a low kill       or V@deck eq a low -12
V@deck tempo a 104         speed %
V@deck rec | rec stop      record the set
```

`V@deck` shortcuts: `V@dk`, `V@decks`.

---

## 9. Limitations worth knowing

- **Spotify can't sit on a deck as a stream** — librespot is a single-device feed,
  so decks use direct sources (YouTube, SoundCloud, Suno, Apple, local files).
  Spotify tracks resolve through YouTube automatically, so they still work, just
  not as two simultaneous Spotify streams.
- **Sync is ±10 %.** Further apart and the refusal is deliberate; no chipmunk vocals.
- **Beat grids are assumed to start at 0:00.** Right for most dance/pop, wrong for
  free-tempo intros — use **nudge** there.
- Discord voice is the ceiling: 48 kHz Opus at 64–256 kbps depending on boost tier.
- Deck loads need YouTube to cooperate; if a load fails, try a different upload or
  a Spotify name instead of a link.
