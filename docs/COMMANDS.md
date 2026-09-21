# Vaporzr — Command Reference

The in-Discord reference is `/help` (or `V@help`) — it opens a tappable
category menu. `V@help <category>` jumps straight to one. This file is the
canonical list for contributors and for sharing.

Every slash command has a `V@` prefix shortcut. Prefix aliases are shown next to
each command.

Legend: `[/cmd]` = slash, `[V@x]` = prefix.

---

## 🎵 Playback

| Slash | Prefix | What it does |
|---|---|---|
| `/play <name\|link>` | `V@p` | Play a song. A **text search opens an interactive picker**; a link plays directly; **attach a file** to play it locally. |
| `/insert <name\|link>` | `V@i` | Queue a track to play **next**. |
| `/yt <link\|search>` | — | Play from YouTube (link or search). |
| `/pause` | `V@pau` | Pause. |
| `/resume` | `V@r` | Resume. |
| `/toggle` | `V@t` | Pause/resume. |
| `/skip` | `V@s` | Skip. Non-DJs (see DJ role) start a **vote-to-skip**. |
| `/nowplaying` | `V@np` | Show the current track. |
| `/volume <0-100>` | `V@v` | Set volume. |
| `/clear` | `V@c`, `V@stop` | Stop and clear the queue. |

## 📜 Queue

| Slash | Prefix | What it does |
|---|---|---|
| `/queue` | `V@q` | Show the queue (paged). |
| `/shuffle` | `V@sh` | Shuffle the queue. |
| `/remove <#>` | `V@rem <#>` | Remove a queued track (autocompletes). |
| `/dedupe` | `V@dd` | Remove duplicate upcoming tracks. |
| `/bulk <tracks>` | `V@bulk <a; b; c>` | Queue a list at once (one per line or `;`, max 10). |
| `/skipto` | `V@skipto` | Pick a future queued track to jump to — drops the tracks it skips. Off by default; a mod enables it with `/skiptoggle`. |
| `/skiptoggle <on\|off>` | `V@skiptoggle` | Allow `/skipto` in this server (mod). |

## 🌊 Autoplay

| Slash | Prefix | What it does |
|---|---|---|
| `/autoplay` | `V@autoplay` (`V@ap`) | Show the current mode. |
| `/autoplay mode:off\|basic\|smart` | `V@autoplay off\|basic\|smart` | Set the mode. |
| `/autoplay now:true` | `V@autoplay now` | Queue one more track right now. |
| `/autoplay count:<1-10>` | `V@autoplay count <1-10>` | How many tracks to buffer ahead. |
| `/endwav on\|off\|status` | `V@ew on\|off` | Endless Wave shortcut (on = smart). |

**Modes**
- **off** — stop when the queue ends.
- **basic** — queue one related track (fast, no vibe analysis).
- **smart** — Endless Wave: Spotify recommendations + audio-feature scoring,
  evolving energy/tempo arc, artist cooldowns, remix/cover dedup, Deezer fallback.

## 🔊 Voice

| Slash | Prefix | What it does |
|---|---|---|
| `/join` | `V@j` | Pull Vaporzr into your voice channel. |
| `/leave` | `V@l` | Leave and clear the queue. |
| `/device list` | — | Show the Spotify Connect device status. |
| `/device select <name>` | — | Rename the Spotify Connect device. |

## 💾 Library (playlists)

| Slash | Prefix | What it does |
|---|---|---|
| `/playlist save <name>` | `V@save <name>` | Save the current queue as a playlist. |
| `/playlist load <name>` | `V@load <name>` | Load a saved playlist. |
| `/playlist list` | `V@playlists`, `V@pl` | List saved playlists. |
| `/playlist delete <name>` | `V@del <name>` | Delete a playlist. |

Names autocomplete. Up to 25 playlists/server, 200 tracks each.

## 🎛️ FX & DJ

| Slash | Prefix | What it does |
|---|---|---|
| `/speed <mode>` | `V@speed` | `nightcore`, `slowed`, `normal`. |
| `/bassboost <5\|8\|10>` | `V@bass` | Bass boost in dB. |
| `/sfx <id>` | `V@sfx` | Play a sound effect (autocompletes). |
| `/dj` | `V@dj` | Toggle the soundboard (mod). |
| `/djrole @role` | `V@djrole @role` | Set the DJ role (mod). `off` clears it. |
| `/voteskip on\|off` | `V@vs on\|off` | Require a majority vote to skip (mod). `off` = anyone can skip instantly. |
| `/duck [seconds]` | `V@duck [seconds]` | Manually lower the music so people can talk (default 30s; `cancel` stops it). |
| `/duckmode off\|auto\|hosts` | `V@dmode` | Auto-duck while people talk (mod): `off` (default), `auto` (any speaker), `hosts` (DJ/owner only). |
| `/npchannel` | `V@npc` | Post the live now-playing strip in this channel (mod). `off` disables it. **The bot never posts it anywhere else.** |
| `/ambient on\|off` | `V@ambient` | Play a quiet lo-fi/ambient track when the queue ends (mod). Persisted per guild. Only fires when Endless Wave can't refill the queue. |

Queue-add confirmations ("Added to queue") auto-delete after ~12s so busy
channels don't fill with bot replies.

Members with the **DJ role** (or mod/admin/owner) skip and control playback
instantly; everyone else triggers a majority **vote-to-skip** among the humans
in the bot's voice channel (unless vote-skip was turned off).

## 🎤 Lyrics

| Slash | Prefix | What it does |
|---|---|---|
| `/lyrics [query]` | `V@lyr` | Lyrics for the current or searched song. |
| `/karaoke` | `V@k` | Live karaoke highlight mode. |

## 🎨 Visuals

| Slash | Prefix | What it does |
|---|---|---|
| `/panel` | `V@pan` | Post the in-channel control panel. |
| `/viz` | `V@viz` | Open the web visualizer (MilkDrop). |
| `/theme` | `V@th` | Pick a color mood. |
| `/wave` | `V@wave` | Waveform snapshot. |
| `/burst` | `V@burst` | Animated clip of the current audio. |
| `/screensaver` | `V@sc` | Idle screensaver. |
| `/sensitivity <0.5-1.5>` | `V@sens` | Beat reactivity. |

## 🛠️ System

| Slash | Prefix | What it does |
|---|---|---|
| `/diag` | `V@diag` | Diagnostics: gateway ping, DAVE, voice, librespot, sessions. |
| `/stats` | — | Bot statistics. |
| `/sleep <30m\|1h>` | `V@sleep` | Sleep timer. |
| `/help` | `V@help` | This menu. |
| `/invite` | `V@invite` | Add Vaporzr to a server. |
| `/key rotate` | `V@key` | Web access links (admin). |
| `/perms` | — | Command levels & roles (admin, autocompletes). |
| `/cookie-refresh` | — | Re-export YouTube cookies (admin). |
| `/player` | `V@player` | Desktop player window (admin). |

---

## Supported play sources

Paste a link with `/play` or `V@p` — sources are auto-detected. Plain text
searches Spotify first, then falls back to YouTube.

| Source | Links / forms | Notes |
|---|---|---|
| **Spotify** | `open.spotify.com` / `play.spotify.com` / `embed.spotify.com`, `spotify:` URIs; free-text search | track, album, playlist, artist; streams via YouTube match |
| **YouTube** | `youtube.com/watch`, `youtu.be`, `/shorts`, `/embed`, `/live`, playlists (`?list=`) | full stream resolution |
| **YouTube Music** | `music.youtube.com/watch`, `music.youtube.com/playlist` | treated as YouTube |
| **SoundCloud** | `soundcloud.com`, `snd.sc`, `on.soundcloud.com`, `/sets/` | DRM tracks fall back to a YouTube match |
| **Apple Music** | `music.apple.com`, `geo.music.apple.com`, `itunes.apple.com` | song, album, playlist; streams via YouTube match |
| **Suno** | `suno.com/song|s|embed|clip|playlist`, `cdn1.suno.ai`, or a bare song UUID | direct CDN mp3 |
| **Bandcamp, Deezer, Tidal, Mixcloud, Audiomack, Jamendo, Qobuz** | any track URL | resolved with yt-dlp |
| **Direct media** | `.mp3 .flac .ogg .opus .m4a .aac .webm .mp4 .mkv .m3u8 …` | streamed directly (HLS supported) |
| **Local files** | attach a file to `V@p` / `/play` | stored under `data/uploads`, played via ffmpeg (any audio/video format) |

> If a source fails, check `/diag` and the bot logs — yt-dlp cookies/proxy
> settings (`apps/bot/.env`) affect YouTube and the yt-dlp-backed sources.
