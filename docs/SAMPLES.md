# Samples and dropped tracks

The sample bank (eight pads in the mixer column) is a folder of one-shots that
get mixed under the live decks, so a horn, a clap or a vocal stab lands **inside**
the same Opus stream everyone hears.

## Adding your own

Three ways, all from the deck page:

1. **Drag a file onto the bank** — drop it anywhere on the SAMPLE BANK block.
2. **Press `+`** — the last tile opens a file picker.
3. **Copy it into `data/samples/`** on the bot host — the pads pick it up on the
   next state push (files are listed alphabetically, first 7 show as pads).

Accepted: `.wav` `.mp3` `.ogg` `.flac` `.m4a` `.opus`, up to **12 MB** per pad and
**12 s** of audio (longer files are cut at 12 s when decoded). Uploads need
control scope — the same key as the panel.

Dropping the same name twice replaces the pad.

## Dropping a track straight onto a deck

Drag an audio file onto either **deck card**. It uploads to `data/uploads/`
(cleaned up after 30 days) and is cued as that deck's track — no search, no
stream resolve. Up to **64 MB**, same formats as above. Mixed sets of local
files and Spotify/YouTube links work fine: the deck does not care where the
bytes came from.

Everything the LOAD box already accepts keeps working: song names, Spotify /
YouTube / SoundCloud links, direct audio URLs, and local paths.

## The starter pack

`apps/bot/assets/samples/` ships eight public-domain one-shots from the
[open-drums](https://github.com/fluid-music/open-drums) TR-707 set — kick, snare,
clap, closed and open hat, rim, low tom, tambourine. They are copied into
`data/samples/` on first run, and an upload with the same filename wins.
Provenance: `apps/bot/assets/samples/CREDITS.md`.

## Where to get more (all free, all safe to use)

| Source | What it is | Licence |
|---|---|---|
| [Sonic Pi `etc/samples`](https://github.com/sonic-pi-net/sonic-pi/tree/main/etc/samples) | Kicks, snares, cymbals, cowbell, tabla, FX — the pack that made Sonic Pi famous | CC0 (freesound donations + Arovane) |
| [fluid-music/open-drums](https://github.com/fluid-music/open-drums) | Classic drum machines (TR-707, TR-808/909 sets) | Public domain |
| [stargatedaw/stargate-sample-pack](https://github.com/stargatedaw/stargate-sample-pack) | Crowd-sourced pack explicitly meant for redistribution | CC0 |
| [freesound — CC0 + drum tag](https://freesound.org/browse/tags/?f=tag%3A%22CC0%22+tag%3A%22drum%22) | Hundreds of one-shots; filter by CC0 | CC0 |
| [VSCO-2-CE](https://github.com/sgossner/VSCO-2-CE) | Orchestral/community samples | CC0 |

Avoid packs whose licence says "royalty-free for your music" but forbids
redistribution — fine for personal use, not fine to commit to a repo.
