/**
 * End-to-end voice integration test.
 *
 * Connects a throwaway Discord client with the bot's token, joins a real voice
 * channel, then drives the actual Session pipeline: local-file playback via
 * ffmpeg (decode -> resample -> voice), a real YouTube source resolution +
 * stream, pause/resume, volume, and a DJ sound effect. Verifies the whole
 * chain with live assertions instead of mocks.
 *
 * Run: npx tsx integration-voice.ts
 *
 * NOTE: shares the bot's token, so stop the running bot first (a second login
 * kicks the first). The bot must be restarted afterwards.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ChannelType, Client, GatewayIntentBits } from 'discord.js';
import { config } from './src/config.js';
import { Session } from './src/session.js';
import { resolveYoutubeVideo } from './src/youtube.js';

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
};

const waitFor = (cond: () => boolean, timeoutMs: number, intervalMs = 200): Promise<boolean> =>
  new Promise((resolve) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });

async function main(): Promise<void> {
  console.log('integration starting');
  if (!config.discordToken) {
    console.error('FAIL — DISCORD_TOKEN missing');
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const ready = new Promise<void>((resolve) => client.once('clientReady', () => resolve()));
  await client.login(config.discordToken);
  await ready;
  console.log(`connected as ${client.user?.tag}`);

  const guild = client.guilds.cache.first();
  if (!guild) {
    console.error('FAIL — bot is not in any guild');
    process.exit(1);
  }
  await guild.channels.fetch();
  // Cache the bot member so guild.voiceAdapterCreator has someone to bind to.
  await guild.members.fetch(client.user!.id);
  const voiceCh = guild.channels.cache.find((c) => c.type === ChannelType.GuildVoice);
  check('found a voice channel', Boolean(voiceCh), voiceCh?.name);
  if (!voiceCh) process.exit(1);

  const session = new Session(guild.id, null);

  // 1. Join a real voice channel (Discord throttles rapid voice reconnects,
  //    so retry a few times before giving up).
  let joined = false;
  for (let attempt = 1; attempt <= 4 && !joined; attempt++) {
    try {
      await session.voice.join(guild.id, voiceCh.id, guild.voiceAdapterCreator);
      joined = true;
    } catch (err) {
      console.log(`  join attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt < 4) await new Promise((r) => setTimeout(r, 8000));
    }
  }
  if (!joined) {
    check('joined voice channel', false, 'after 4 attempts');
    process.exit(1);
  }
  check('joined voice channel', session.voice.isJoined(), voiceCh.name);
  check('channel id tracked', session.voice.getChannelId() === voiceCh.id);

  // 2. Generate a short test tone and play it through the full ffmpeg path.
  const tonePath = path.join(os.tmpdir(), `vaporzr-test-tone-${Date.now()}.wav`);
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      config.ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ac', '2', '-ar', '48000', '-y', tonePath],
      { windowsHide: true },
    );
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tone gen exited ${code}`))));
    proc.on('error', reject);
  });
  session.queue.enqueue(
    { uri: 'local:test-tone', name: 'Test Tone', artists: [], album: '', durationMs: 8000, source: 'local', filePath: tonePath },
    'integration-test',
  );
  await session.playback.play();
  check('local playback started', session.queue.getState().playing);

  const posStarted = await waitFor(() => session.voice.getPositionMs() > 500, 20_000);
  check('ffmpeg stream producing position', posStarted, `${session.voice.getPositionMs()}ms`);
  const pos1 = session.voice.getPositionMs();
  await new Promise((r) => setTimeout(r, 2000));
  const pos2 = session.voice.getPositionMs();
  check('position advances', pos2 > pos1, `${pos1} -> ${pos2}`);
  check('state positionMs tracked', session.queue.getState().positionMs > 0, `${session.queue.getState().positionMs}ms`);
  check('tracksPlayed incremented', session.playback.tracksPlayed >= 1, `${session.playback.tracksPlayed}`);

  // 3. Pause / resume / volume / sfx while audio is flowing.
  session.playback.pause();
  check('pause works', !session.queue.getState().playing);
  session.playback.resume();
  check('resume works', session.queue.getState().playing);
  session.playback.volume(33);
  check('volume set', session.queue.getState().volume === 33, `${session.queue.getState().volume}`);
  const sfxOk = await session.playback.playSoundEffect('boom');
  check('dj sfx mixed', sfxOk === true);

  // 4. Real YouTube source resolution + stream.
  const ytId = 'dQw4w9WgXcQ';
  let video;
  try {
    video = await resolveYoutubeVideo(ytId);
  } catch (err) {
    video = null;
    check('youtube resolve', false, err instanceof Error ? err.message : String(err));
  }
  if (video) {
    check('youtube stream url resolved', video.streamUrl.length > 0);
    const uri = `youtube:video:${ytId}`;
    session.queue.enqueue(
      { uri, name: video.name, artists: video.artists ?? [], album: '', durationMs: video.durationMs, source: 'youtube' },
      'integration-test',
    );
    while (session.queue.getCurrentTrack()?.uri !== uri) {
      if (!session.queue.next()) break;
    }
    await session.playback.play();
    const ytStreamed = await waitFor(() => session.queue.getState().source === 'youtube' && session.voice.getPositionMs() > 500, 30_000);
    check('youtube streaming', ytStreamed, `${session.queue.getCurrentTrack()?.name} @ ${session.voice.getPositionMs()}ms`);
    check('tracksPlayed incremented again', session.playback.tracksPlayed >= 2, `${session.playback.tracksPlayed}`);
  }

  // 5. Cleanup.
  session.playback.stopAll();
  session.voice.leave();
  check('left voice', !session.voice.isJoined());
  client.destroy();
  try {
    fs.rmSync(tonePath, { force: true });
  } catch {
    /* ignore */
  }
}

main().then(
  () => {
    console.log(failures === 0 ? '\nALL VOICE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  },
  (err) => {
    console.error('integration test crashed:', err);
    process.exit(1);
  },
);
