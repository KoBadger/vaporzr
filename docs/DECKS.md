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

## 2. Views: Simple and Pro

The page opens in **Simple** on a first visit and remembers the choice;
`?mode=simple` / `?mode=pro` forces either, and the switch sits next to the
server picker.

**Simple** keeps the same rig but hides what a first-timer does not need — tempo
fader, trim, EQ and kill buttons, nudge, beat-lock, recording, the match readout
and the MIDI footer. A one-line **coach** above the decks names the next useful
move ("Load Deck B", "press PLAY on B", "press SYNC"), and **?** reopens a
five-step guide. Nothing is deleted in Simple, only tucked away.

**Pro** shows every control plus the keyboard hints, MIDI clock out and the
sync/drift readout.

## 2a. The controls

Each deck card has, top to bottom:

| Control | What it does |
|---|---|
| Waveform | Decoded peaks. Click anywhere to seek. Amber lines are cue pads, cyan band is the loop |
| Seek bar | Same as the waveform, finer target |
| Load | Resolve + download + cue |
| Play / Cue | Transport, or reset to 0:00 |
| Low / Mid / High + Kill | 3-band EQ as **rotary knobs** on the channel strip, −40 dB … +6 dB. 12 o'clock is 0 dB; the arc grows left for a cut and right for a boost, so a flat channel is an empty ring. Drag up/down (hold Shift for fine), scroll, arrow keys, double-click to snap back to 0. Kill buttons slam a band out |
| Trim | Per-deck gain, same knob, 0–100 % |
| Tempo (vertical fader) | atempo, pitch preserved (92–108 %) |
| Nudge ±25 ms | Manual phase correction |
| Platter mode | **VINYL** drags the track under the needle; **CDJ** turns a drag into ±ms nudges while it plays. `BAR n.n` under it is the bar at the playhead |
| Q | Quantize: seeks snap to the beat grid (armed by default) |
| **Filter** | One knob per deck: low-pass ← **off** → high-pass (centre detent) |
| 8 cue pads | Tap empty = set at the playhead, tap set = jump, hold = clear (right-click works too) |
| Loop 1/4 · 1/2 · 1 · 2 · 4 · 8 · On/Off · Exit | Beat-quantised loop, cached as PCM so the wrap is seamless |

Header: **SYNC**, **Lock**, **Record**, **Play both**, **Pause**, **Stop decks**.
Bottom: crossfader, FX bank, a **SYNC / MATCH** readout (each deck's effective BPM,
tempo % and the drift between them — `LOCKED` when the bot is holding phase), MIDI status.

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

## 4. FX bank and sample bank

Eight pads above the fader: `riser`, `reverse`, `drop`, `boom`, `zap`, `airhorn`,
`applause`, `countdown`. They come from the bot's soundboard and are mixed over
the deck output, so they work mid-mix without interrupting playback.

Below them is the **sample bank**: every audio file in the bot's
`data/samples/` folder becomes a pad (first eight shown, more via
`V@deck sample <n>`). Drop your own one-shots there — Splice downloads, drum
hits, vocal stabs — and they're live without a restart (the list refreshes every
few seconds).

Keys: `q w e r t y u i` fire the FX pads in order.

**Library, search and setups.** `LIBRARY` opens the whole `data/samples/`
folder, grouped by subfolder. The search box suggests as you type (first
letters are enough — `htcl` finds `hat-closed`), arrows move the highlight,
`Enter` drops the sample on the first empty pad, and every entry still drags
onto any pad. Saved setups load/save/delete below the list.

`FILL` tops up empty pads from the library, spreading across categories so you
don't end up with eight kicks. `RESET` puts the starter eight back.

**Keys and headroom.** The mixer header shows each deck's Camelot key
(`8A`, `9A`, …), tinted green when the pair is harmonic, amber for an energy
lift and red for a clash. Under the crossfader a one-line `MIX SUM` readout shows
both sides after the fader in dB — green with room to spare, amber inside 3 dB,
red past full scale, where the `CLIP` lamp lights and the fix is to pull a trim
back. It is deliberately text, not a bar: two horizontal bars under the fader
read as a second crossfader. `SYNC / MATCH` also draws a **drift ring**: the arc
grows with the phase error the lock is correcting, and the number inside is
milliseconds.

**Capture.** `CAPTURE CUE → A` / `→ B` under the hot cues copies this deck's
playhead onto the other deck's first free cue pad — the fast way to line up a
drop you just found.

**Type-ahead.** Start typing in either deck's load box and a short list of
matches appears (Spotify first, then YouTube), with source and duration. Arrow
keys move, `Enter` loads the exact track the row points at — no re-resolving a
misspelled search. The same `/api/search` powers the panel's search box and the
`/request` jam page, so every Vaporzr search behaves the same way.

## 4a. DJ filter

Each deck has a single filter knob: **left of centre closes a low-pass**
(down to 180 Hz), **centre is bypass**, **right of centre opens a high-pass**
(up to 9 kHz). Sweeping it into a drop is the classic CDJ move — kill the bass
with the HPF, then whip it back to centre on the downbeat.

---

## 5. Keyboard

| Key | Action |
|---|---|
| `space` | Play / pause both decks |
| `←` `→` | Crossfader by 4 % |
| `1`–`8` | Cue pad on deck A (sets if empty, jumps if set) |
| `shift`+`1`–`8` | Same on deck B |
| `q w e r t y u i` | FX pads |

Cue jumps start **140 ms early** on purpose: Discord's jitter buffer adds roughly
that much, so the hit lands on the beat instead of after it.

---

## 6. MIDI

Plug in any class-compliant controller (nothing to configure). Default mapping:

| Control | Target |
|---|---|
| CC 1 | Crossfader |
| CC 2 / CC 3 | Trim A / B |
| CC 4–6 | EQ A: low, mid, high |
| CC 7–9 | EQ B: low, mid, high |
| CC 10 / 11 | DJ filter A / B (centre = bypass) |
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
V@deck c <song|link>       load deck C (line)   V@deck d <song|link>   load deck D (line)
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
V@deck filter a 30         0 = closed LPF, 50 = off, 100 = open HPF
V@deck sample              list the sample bank     V@deck sample 3   fire pad 3
V@deck rec | rec stop      record the set (posts track count + top artists)
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
- **Four decks exist in the engine; the page shows two at a time.** Decks C and D
  are live (load them with `V@deck c <song>`, `V@deck d <song>`) and mix as line
  channels: the crossfader owns A/B, C and D play at their own trim so a second
  bank stays audible however the fader is parked. The banked web surface is the
  next step. Measured cost of four simultaneous MP3 decks on the 2-core VPS:
  **0.10 CPU cores** total (2 decks: 0.08), so the mixer is not the constraint.
- Discord voice is the ceiling: 48 kHz Opus at 64–256 kbps depending on boost tier.
- Deck loads need YouTube to cooperate; if a load fails, try a different upload or
  a Spotify name instead of a link.

---

## 10. Controller and DAW integration

### Hands-on gestures (built in)

| Gesture | What it does |
| --- | --- |
| Drag the platter | Scrub; the deck lands exactly where you release |
| Press **A** / **B** | Play/pause that deck (desktop keyboard) |
| **S** / **L** | Sync B to A / toggle beat-lock |
| Tap a hot cue | Set it when empty, jump to it when set |
| Hold a hot cue (~0.5 s) | Clear it (the right-click of a phone) |
| Space / `←` `→` | Both decks play-pause / crossfader |
| Pitch fader | Snaps through the 0 % detent, like hardware |

Phones get a fixed **thumb dock** under the page (A play, A cue, crossfader,
B cue, B play) so transport never scrolls out of reach, plus 44 px+ pads.

### MIDI in (hardware controller)

Any class-compliant controller is mapped without configuration:

| Control | Deck page action |
| --- | --- |
| CC 1 | Crossfader |
| CC 2 / 3 | Trim A / B |
| CC 4-9 | EQ low/mid/high, A then B — same law as the knobs, so CC 64 is 0 dB |
| CC 10 / 11 | Filter A / B |
| Notes 36-43 | FX pads (`q w e r t y u i`) |
| Notes 48-55 | Hot cues 1-8 on deck A |

### MIDI out — Traktor, Serato and DAWs

The mixer footer has **MIDI OUT** with a port picker and a **CLOCK** button.

1. Install a virtual MIDI port: **loopMIDI** (Windows) or enable **IAC Driver**
   (macOS Audio MIDI Setup).
2. Open `/deck`, pick that port in **MIDI OUT**, press **CLOCK**.
3. The page now sends `Start`/`Stop` with the decks and **24 PPQN** clock at the
   playing deck's BPM (it follows tempo changes).

What each host does with that:

- **Traktor Pro** — set its clock to **MIDI Clock, slave** and choose the same
  port as input (`Preferences → Controller Manager → Add → Generic MIDI` for
  transport/CC mapping). Beat-phase sync then follows Vaporzr's decks.
- **Serato DJ Pro** — has no MIDI-clock sync (it syncs via Ableton Link, which a
  browser cannot join). It can still be **controlled by** or **control** the page
  through a virtual port + its MIDI mapping: map its faders/knobs to the CC list
  above, and its transport buttons to notes 48-55 for cues.
- **Ableton Live / Bitwig** — enable the port as a *Sync* input and turn on EXT;
  the clock will drive the session tempo.
- **Rekordbox** — accepts MIDI clock on the same terms as Traktor.

Browser note: Web MIDI needs a secure origin — `/deck` is served over the panel's
HTTPS tunnel, so this works on the deployed host but not over plain LAN `http://`.

---

## 11. Visualizer overlay

The visualizer (/viz, and the same page inside the Discord Activity) can show a
**live decks strip**: two mini decks with position, cue ticks, loop region, a
crossfader and an **ON AIR** pill, blended over the visuals.

- Toggle it with the deck button in the toolbar or the D key. It opens by
  itself when a deck loads, and remembers being dismissed.
- **SUBTLE / MEDIUM / SOLID** set the glass opacity so the visuals stay readable.
- **COACH** swaps the cue ticks and loop shading for a plain-language line about
  what is happening ("Deck A is out front. Deck B is cued, waiting for its
  moment."). Handy on a stream where the audience is new to mixing.
- **Spectating vs driving:** an Activity viewer is a guest and gets the read-only
  strip. Opened with the control key (for example the panel's *Live decks* link,
  which carries a rotating control invite), the strip also gets A play, CUE,
  SYNC, CUE B, B play and a draggable crossfader.
- On phones the strip stacks and drops the blur for performance.

### Official video panel

When the bot knows the official video for the track (it looks it up once per
track and caches the id), /viz and the Activity show a **muted video panel** in
the empty upper-left lane: it starts at the track's position and seeks itself
when the audio and the video drift past 2.5 s. It hides while nothing is
playing (or when a pause is reported) and is off on phones, where the layout has
no spare lane.

The video is **not a YouTube iframe**. Official music videos very often refuse
embedding, and the Discord Activity CSP blocks youtube.com outright, so the bot
streams a 360p MP4 through its own `/api/video/<id>` route (cached on the data
volume, served with Range support, pruned to the last 12 tracks). That is why
the panel works in the Activity as well as in a browser.

The same lookup powers the **video card** the bot posts in the now-playing
channel - text plus thumbnail, no voice unless `V@w vj on` is set. Two rules
keep the channel readable:

- **Only real releases get a card.** A hit is accepted only when its channel is
  the artist's own, a `<Artist> - Topic` channel (YouTube Music's licensed auto
  channel) or `<Artist>VEVO`. A fan lyric upload or a background loop is never
  announced as official - it may still fill the visualizer panel, which labels
  itself `VIDEO` rather than `OFFICIAL VIDEO` in that case. Titles containing
  "cover", "nightcore", "slowed", "1 hour", "loop" and friends are skipped
  outright.
- **One card at a time.** Posting a new card deletes the previous one (same
  channel), so a long set leaves a single video rather than a wall of them. The
  bot also refuses to post twice for the same track, even when two track-start
  signals race the lookup.

`V@w videos off` stops the cards; the visualizer panel still follows whatever
the bridge reports (silencing the post does not blank the picture).