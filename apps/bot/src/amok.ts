import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '@vaporzr/core/config';

export interface AdcCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  quota_project_id?: string;
}

interface DetectIntentResponse {
  queryResult?: {
    responseMessages?: Array<{
      text?: {
        text?: string[];
      };
    }>;
  };
}

export interface AmokRoomContext {
  scopeId: string;
  guildId?: string | null;
  userId: string;
  username?: string;
  nowPlaying?: string | null;
  upcomingQueue?: string[];
  leaderboardSummary?: string | null;
  recentChat?: string[];
  voiceMembers?: string[];
  ewSteerDirective?: string | null;
  forceRoomContext?: boolean;
}

export interface AmokResult {
  text: string;
  queueQueries: string[];
}

export interface WeaselWavePick {
  query: string;
  why: string;
}

interface WeaselUserMemory {
  username: string;
  facts: string[];
  favoriteArtists: Record<string, number>;
  updatedAt: number;
}

interface WeaselMemoryStoreData {
  users: Record<string, WeaselUserMemory>;
  guildLore: Record<string, string[]>;
}

const DEFAULT_PROJECT_ID = 'projbdgr';
const DEFAULT_LOCATION = 'global';
const DEFAULT_AGENT_ID = '3762bcaf-20c6-404b-a94b-4803b3b09213';
const DEFAULT_TTS_VOICE = 'en-US-Casual-K';

let cachedToken: { token: string; expiresAt: number; quotaProject: string } | null = null;
const sessionEpochs = new Map<string, number>();
let memoryCache: WeaselMemoryStoreData | null = null;

function memoryFilePath(): string {
  return path.join(config.dataDir, 'weasel-memory.json');
}

function loadMemoryStore(): WeaselMemoryStoreData {
  if (memoryCache) return memoryCache;
  try {
    const p = memoryFilePath();
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<WeaselMemoryStoreData>;
      memoryCache = {
        users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
        guildLore: parsed.guildLore && typeof parsed.guildLore === 'object' ? parsed.guildLore : {},
      };
      return memoryCache;
    }
  } catch {
    /* start fresh on corrupt file */
  }
  memoryCache = { users: {}, guildLore: {} };
  return memoryCache;
}

function saveMemoryStore(): void {
  if (!memoryCache) return;
  try {
    const p = memoryFilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(memoryCache, null, 2), 'utf8');
  } catch {
    /* non-fatal */
  }
}

/** Record artists a user queued so The Weasel learns their music taste over time. */
export function noteWeaselUserArtists(userId: string, username: string, artists: string[]): void {
  if (!userId || artists.length === 0) return;
  const store = loadMemoryStore();
  const entry = (store.users[userId] ??= {
    username: username || userId,
    facts: [],
    favoriteArtists: {},
    updatedAt: Date.now(),
  });
  if (username) entry.username = username;
  for (const raw of artists) {
    const a = raw.trim();
    if (!a) continue;
    entry.favoriteArtists[a] = (entry.favoriteArtists[a] ?? 0) + 1;
  }
  entry.updatedAt = Date.now();
  saveMemoryStore();
}

/** Explicitly save a user or server lore fact to The Weasel's permanent memory. */
export function rememberWeaselFact(
  guildId: string | null | undefined,
  userId: string,
  username: string,
  fact: string,
): void {
  const clean = fact.replace(/\s+/g, ' ').trim().slice(0, 220);
  if (!clean) return;
  const store = loadMemoryStore();
  const entry = (store.users[userId] ??= {
    username: username || userId,
    facts: [],
    favoriteArtists: {},
    updatedAt: Date.now(),
  });
  if (username) entry.username = username;
  if (!entry.facts.includes(clean)) {
    entry.facts.push(clean);
    if (entry.facts.length > 12) entry.facts.shift();
  }
  if (guildId) {
    const lore = (store.guildLore[guildId] ??= []);
    const tagged = `${username || userId}: ${clean}`;
    if (!lore.includes(tagged)) {
      lore.push(tagged);
      if (lore.length > 20) lore.shift();
    }
  }
  entry.updatedAt = Date.now();
  saveMemoryStore();
}

/** Build a compact summary of what The Weasel remembers about this user and server. */
export function getWeaselMemorySummary(
  guildId: string | null | undefined,
  userId: string,
  username?: string,
): string | null {
  const store = loadMemoryStore();
  const parts: string[] = [];
  const u = store.users[userId];
  if (u) {
    const topArtists = Object.entries(u.favoriteArtists)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name} (${count}x)`);
    if (topArtists.length > 0) {
      parts.push(`${username || u.username}'s favorite queued artists: ${topArtists.join(', ')}`);
    }
    if (u.facts.length > 0) {
      parts.push(`Remembered about ${username || u.username}: ${u.facts.slice(-6).join('; ')}`);
    }
  }
  if (guildId && store.guildLore[guildId]?.length) {
    parts.push(`Server lore: ${store.guildLore[guildId].slice(-6).join('; ')}`);
  }
  return parts.length > 0 ? parts.join(' | ') : null;
}

/** Candidate file paths for Google Application Default Credentials. */
export function adcCandidatePaths(): string[] {
  const paths: string[] = [];
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    paths.push(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  }
  paths.push(path.join(config.dataDir, 'gcloud-adc.json'));
  if (process.env.APPDATA) {
    paths.push(path.join(process.env.APPDATA, 'gcloud', 'application_default_credentials.json'));
  }
  paths.push(path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json'));
  return paths;
}

/** Load Google OAuth user/ADC credentials from env or disk. */
export function loadAdcCredentials(): AdcCredentials {
  const inline = (process.env.GOOGLE_ADC_JSON ?? '').trim();
  if (inline) {
    const raw = inline.startsWith('{') ? inline : Buffer.from(inline, 'base64').toString('utf8');
    return JSON.parse(raw) as AdcCredentials;
  }
  for (const p of adcCandidatePaths()) {
    try {
      if (p && fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as AdcCredentials;
        if (parsed.client_id && parsed.client_secret && parsed.refresh_token) {
          return parsed;
        }
      }
    } catch {
      /* try next candidate */
    }
  }
  throw new Error('Google Cloud credentials (gcloud-adc.json) not found for Amok agent.');
}

async function getAccessToken(projectId: string): Promise<{ token: string; quotaProject: string }> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return { token: cachedToken.token, quotaProject: cachedToken.quotaProject };
  }
  const creds = loadAdcCredentials();
  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google OAuth token refresh failed (HTTP ${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error('Google OAuth token response did not include an access_token.');
  }
  const quotaProject = creds.quota_project_id || projectId;
  cachedToken = {
    token: data.access_token,
    expiresAt: now + (Number(data.expires_in) || 3600) * 1000,
    quotaProject,
  };
  return { token: cachedToken.token, quotaProject };
}

/** Build a stable Dialogflow CX session ID per guild/DM + user. */
export function amokSessionId(scopeId: string, userId: string): string {
  const key = `${scopeId || 'dm'}:${userId}`;
  const epoch = sessionEpochs.get(key) ?? 1;
  return `discord-${scopeId || 'dm'}-${userId}-${epoch}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
}

/** Reset a user's conversation memory with Amok in the current guild/DM. */
export function resetAmokSession(scopeId: string, userId: string): void {
  const key = `${scopeId || 'dm'}:${userId}`;
  sessionEpochs.set(key, (sessionEpochs.get(key) ?? 1) + 1);
}

/** Extract the combined reply text from a Dialogflow CX detectIntent payload. */
export function extractAmokReply(payload: DetectIntentResponse): string {
  const messages = payload.queryResult?.responseMessages ?? [];
  const parts: string[] = [];
  for (const m of messages) {
    for (const t of m.text?.text ?? []) {
      const trimmed = t.trim();
      if (trimmed) parts.push(trimmed);
    }
  }
  return parts.join('\n\n');
}

/**
 * Separate a Playbook reply into clean display text and any `WEASEL_QUEUE:`
 * track queries the agent asked Vaporzr to queue.
 */
export function parseWeaselResponse(raw: string): AmokResult {
  const queueQueries: string[] = [];
  const keptLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const m = /^[\s`*_-]*WEASEL_QUEUE:\s*(.+?)\s*[`*_]*$/i.exec(line);
    if (m) {
      for (const item of m[1].split('|')) {
        const cleaned = item
          .replace(/^[`"'*\s-]+|[`"'*\s]+$/g, '')
          .replace(/^\d+\.\s*/, '')
          .trim();
        if (cleaned && queueQueries.length < 5) {
          queueQueries.push(cleaned);
        }
      }
    } else {
      keptLines.push(line);
    }
  }

  const text = compactWeaselText(keptLines.join('\n').trim());
  return { text, queueQueries };
}

/**
 * Keep The Weasel's replies short, punchy, and conversational (1-3 sentences,
 * max ~340 chars) instead of multi-paragraph essays.
 */
export function compactWeaselText(raw: string): string {
  const oneParagraph = raw.split(/\r?\n\s*\r?\n/)[0]?.trim() ?? raw.trim();
  const collapsed = oneParagraph.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 320) return collapsed;
  const sentences = collapsed.match(/[^.!?]+[.!?]+(?:\s|$)/g);
  if (sentences && sentences.length > 0) {
    let out = '';
    for (const s of sentences) {
      if ((out + s).trim().length > 320 && out.length > 0) break;
      out += s;
      if (out.length >= 220) break;
    }
    if (out.trim()) return out.trim();
  }
  return `${collapsed.slice(0, 319)}…`;
}

/** True when a user prompt likely benefits from live Google Search grounding. */
export function shouldGroundOnWeb(prompt: string): boolean {
  return /\b(weather|forecast|temperature|news|headline|headlines|today|tonight|yesterday|last night|this week|right now|current|currently|latest|score|scores|standings|won|winner|who is the|price|stock|bitcoin|btc|eth|release date|2025|2026|search|google|look up|happening|sample|sampled|whosampled|producer|produced by|album|released)\b/i.test(
    prompt,
  );
}

/** Fetch concise live web facts via Vertex AI Gemini with Google Search grounding. */
async function fetchLiveWebFacts(
  prompt: string,
  projectId: string,
  token: string,
  quotaProject: string,
): Promise<string | null> {
  try {
    const url = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/global/publishers/google/models/gemini-2.5-flash:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-goog-user-project': quotaProject,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Provide a concise, factual 2-3 sentence summary answering this query with current facts: ${prompt}`,
              },
            ],
          },
        ],
        tools: [{ googleSearch: {} }],
      }),
      signal: AbortSignal.timeout(9_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((p) => p.text ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text ? text.slice(0, 600) : null;
  } catch {
    return null;
  }
}

/** Background fact extractor: learns personal tastes/facts from user turns without slowing replies. */
async function maybeExtractUserFact(
  guildId: string | null | undefined,
  userId: string,
  username: string,
  userMessage: string,
): Promise<void> {
  if (userMessage.length < 12) return;
  if (
    !/\b(i love|i hate|my favorite|i am|i'm a|i work|i live|i play|i listen|always|never|obsessed with)\b/i.test(
      userMessage,
    )
  ) {
    return;
  }
  try {
    const projectId = (process.env.AMOK_PROJECT_ID ?? DEFAULT_PROJECT_ID).trim();
    const { token, quotaProject } = await getAccessToken(projectId);
    const url = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/global/publishers/google/models/gemini-2.5-flash:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-goog-user-project': quotaProject,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Extract at most ONE durable personal fact or music/food/hobby preference about user "${username}" from their message below. If there is no durable personal fact worth remembering, output exactly NONE.\nMessage: "${userMessage.slice(0, 400)}"`,
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(7_000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const fact = (data.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
    if (fact && !/^none\.?$/i.test(fact) && fact.length <= 180) {
      rememberWeaselFact(guildId, userId, username, fact);
    }
  } catch {
    /* best-effort background learning */
  }
}

/** Clean markdown/emoji from a Weasel line before sending it to Cloud TTS. */
export function cleanWeaselSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`~>#]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^\p{L}\p{N} .,!?'’\-:&()]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
}

/**
 * Build SSML with Pauly Shore surfer prosody: stretches out repeated vowels
 * ("buuuddy", "ju-uice", "chaaa", "duuude") and shifts pitch/rate on signature
 * Weasel slang so Google's California Casual voice acts out the cadence.
 */
export function buildWeaselSsml(text: string): string {
  const clean = cleanWeaselSpeechText(text);
  const escaped = clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const shaped = escaped.replace(
    /\b(bu+ddy|ju+-?u*ice|cha+a*|du+de|so+o+|broham|wheezin'?|myagi|crusty|grindage|cheeza|mahi-mahi|ow-oww+)\b/gi,
    '<prosody rate="70%" pitch="+2.5st">$1</prosody>',
  );
  return `<speak><prosody rate="95%" pitch="+0.8st">${shaped}</prosody></speak>`;
}

/** Convert a 48 kHz 16-bit mono WAV buffer into 48 kHz 16-bit stereo Int16 PCM. */
export function monoWavToStereoPcm(wav: Buffer): { pcm: Buffer; durationMs: number } | null {
  const headerOffset = wav.length > 44 && wav.toString('ascii', 0, 4) === 'RIFF' ? 44 : 0;
  const monoBytes = wav.length - headerOffset;
  const samples = Math.floor(monoBytes / 2);
  if (samples <= 0) return null;
  const stereo = Buffer.allocUnsafe(samples * 4);
  for (let i = 0; i < samples; i++) {
    const s = wav.readInt16LE(headerOffset + i * 2);
    stereo.writeInt16LE(s, i * 4);
    stereo.writeInt16LE(s, i * 4 + 2);
  }
  const durationMs = Math.round((samples / 48_000) * 1000);
  return { pcm: stereo, durationMs };
}

/** Wrap raw 48 kHz 16-bit mono PCM samples in a standard 44-byte RIFF WAV header. */
export function pcmMono48kToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
  header.writeUInt16LE(1, 22); // NumChannels = 1 (mono)
  header.writeUInt32LE(48_000, 24); // SampleRate = 48000
  header.writeUInt32LE(48_000 * 2, 28); // ByteRate
  header.writeUInt16LE(2, 32); // BlockAlign
  header.writeUInt16LE(16, 34); // BitsPerSample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

let cachedPaulyRefDataUri: string | null | undefined;

function getPaulyVoiceRefDataUri(): string | null {
  if (cachedPaulyRefDataUri !== undefined) return cachedPaulyRefDataUri;
  const refPath = process.env.AMOK_VOICE_REF_PATH || path.join(config.dataDir, 'pauly-voice-ref.wav');
  try {
    if (fs.existsSync(refPath)) {
      const b64 = fs.readFileSync(refPath).toString('base64');
      cachedPaulyRefDataUri = `data:audio/wav;base64,${b64}`;
      return cachedPaulyRefDataUri;
    }
  } catch {
    /* fall through */
  }
  cachedPaulyRefDataUri = null;
  return null;
}

/** Resample an arbitrary audio buffer (WAV/MP3) to 48 kHz stereo Int16 PCM via ffmpeg. */
function decodeAudioToStereo48k(audioBytes: Buffer): Promise<{ pcm: Buffer; durationMs: number } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const finish = (res: { pcm: Buffer; durationMs: number } | null): void => {
      if (settled) return;
      settled = true;
      resolve(res);
    };
    try {
      const ff = spawn(
        config.ffmpegPath,
        ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1'],
        { windowsHide: true },
      );
      const timer = setTimeout(() => {
        try {
          ff.kill();
        } catch {}
        finish(null);
      }, 10_000);
      timer.unref?.();
      ff.stdout.on('data', (d: Buffer) => chunks.push(d));
      ff.once('error', () => {
        clearTimeout(timer);
        finish(null);
      });
      ff.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || chunks.length === 0) return finish(null);
        const pcm = Buffer.concat(chunks);
        const durationMs = Math.round((pcm.length / (48_000 * 4)) * 1000);
        finish({ pcm, durationMs });
      });
      ff.stdin.end(audioBytes);
    } catch {
      finish(null);
    }
  });
}

/**
 * Synthesize speech using Zero-Shot Voice Cloning (`resemble-ai/chatterbox` on Replicate)
 * trained on `/app/data/pauly-voice-ref.wav` so it sounds like Pauly Shore's real voice.
 */
async function synthClonedPaulyVoice(cleanText: string): Promise<{ pcm: Buffer; durationMs: number } | null> {
  const repToken = (process.env.REPLICATE_API_TOKEN ?? '').trim();
  const audioPrompt = (process.env.AMOK_VOICE_SAMPLE_URL ?? '').trim() || getPaulyVoiceRefDataUri();
  if (!repToken || !audioPrompt) return null;

  try {
    const res = await fetch('https://api.replicate.com/v1/models/resemble-ai/chatterbox/predictions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${repToken}`,
        'Content-Type': 'application/json',
        Prefer: 'wait=20',
      },
      body: JSON.stringify({
        input: {
          prompt: cleanText.slice(0, 240),
          audio_prompt: audioPrompt,
          exaggeration: 0.65,
          cfg_weight: 0.45,
        },
      }),
      signal: AbortSignal.timeout(22_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { output?: string };
    if (!data.output || typeof data.output !== 'string') return null;
    const wavRes = await fetch(data.output, { signal: AbortSignal.timeout(10_000) });
    if (!wavRes.ok) return null;
    const wavBuf = Buffer.from(await wavRes.arrayBuffer());
    return await decodeAudioToStereo48k(wavBuf);
  } catch {
    return null;
  }
}

/**
 * Synthesize spoken Weasel audio:
 * 1. Primary: Zero-Shot Voice Cloning (`resemble-ai/chatterbox`) using Pauly Shore's
 *    real voice reference (`/app/data/pauly-voice-ref.wav`).
 * 2. Fallback: Google Cloud TTS (`en-US-Casual-K`) with SSML surfer prosody shaping.
 */
export async function synthWeaselVoice(text: string): Promise<{ pcm: Buffer; durationMs: number } | null> {
  const clean = cleanWeaselSpeechText(text);
  if (!clean) return null;

  const cloned = await synthClonedPaulyVoice(clean);
  if (cloned) return cloned;

  const projectId = (process.env.AMOK_PROJECT_ID ?? DEFAULT_PROJECT_ID).trim();
  const voiceName = (process.env.AMOK_TTS_VOICE ?? DEFAULT_TTS_VOICE).trim();
  const { token, quotaProject } = await getAccessToken(projectId);
  const ssml = buildWeaselSsml(clean);

  const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-goog-user-project': quotaProject,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: { ssml },
      voice: { languageCode: 'en-US', name: voiceName },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 48000 },
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { audioContent?: string };
  if (!data.audioContent) return null;
  const wav = Buffer.from(data.audioContent, 'base64');
  return monoWavToStereoPcm(wav);
}

/**
 * Transcribe a spoken Discord voice-channel utterance via Vertex AI Gemini 2.5 Flash
 * Multimodal Audio. Returns the transcript if intelligible, or null on silence/noise.
 */
export async function transcribeVoiceUtterance(wav: Buffer): Promise<string | null> {
  if (wav.length < 48_000) return null; // ignore < 0.5s micro-blips
  try {
    const projectId = (process.env.AMOK_PROJECT_ID ?? DEFAULT_PROJECT_ID).trim();
    const { token, quotaProject } = await getAccessToken(projectId);
    const url = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/global/publishers/google/models/gemini-2.5-flash:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-goog-user-project': quotaProject,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/wav',
                  data: wav.toString('base64'),
                },
              },
              {
                text: 'Transcribe the exact English speech in this audio clip. If there is no clear speech or only background noise/coughing, reply with exactly NONE.',
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const transcript = (data.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
    if (!transcript || /^none\.?$/i.test(transcript)) return null;
    return transcript;
  } catch {
    return null;
  }
}

/**
 * AI Deep-DNA Crate-Digger for Endless Wave (`smart` mode) & Harmonic Set Architect:
 * Uses Gemini 2.5 Flash + Google Search grounding to select next tracks that share
 * producer lineage, sample DNA, micro-subgenre/scene, lyrical vibe, and harmonic flow.
 */
export async function curateEndlessWaveTracks(opts: {
  seedTracks: Array<{ name: string; artists: string[] }>;
  dnaSummary?: string;
  avoidNames?: string[];
  steerDirective?: string | null;
  count?: number;
}): Promise<WeaselWavePick[]> {
  if (opts.seedTracks.length === 0 && !opts.steerDirective) return [];
  try {
    const projectId = (process.env.AMOK_PROJECT_ID ?? DEFAULT_PROJECT_ID).trim();
    const { token, quotaProject } = await getAccessToken(projectId);
    const url = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/global/publishers/google/models/gemini-2.5-flash:generateContent`;
    const count = Math.min(5, Math.max(1, opts.count ?? 3));
    const seeds = opts.seedTracks.map((t) => `"${t.name}" by ${t.artists.join(', ')}`).join('; ');
    const avoid = (opts.avoidNames ?? []).slice(0, 25).join(', ');

    const prompt = [
      `You are an elite crate-digging musicologist and harmonic DJ curating the next ${count} track(s) for Vaporzr's Endless Wave autoplay.`,
      seeds ? `Recent seed tracks in the session: ${seeds}.` : '',
      opts.dnaSummary ? `Measured sonic/harmonic DNA: ${opts.dnaSummary}.` : '',
      opts.steerDirective
        ? `ACTIVE USER VIBE / HARMONIC ARC DIRECTIVE (prioritize this journey): ${opts.steerDirective}.`
        : 'Match the deep musical DNA of the seeds: consider shared producers, sample lineage (WhoSampled connections), exact era/micro-scene, lyrical mood, and smooth BPM/Camelot key flow.',
      avoid ? `Do NOT pick any of these already-played songs: ${avoid}.` : '',
      `Output ONLY ${count} lines, one per track, in this exact format:`,
      `WAVE_PICK: Artist - Track Title || 1-sentence reason explaining the producer/sample/vibe/harmonic connection`,
    ]
      .filter(Boolean)
      .join('\n');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-goog-user-project': quotaProject,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ googleSearch: {} }],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const raw = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('\n');
    return parseWavePicks(raw);
  } catch {
    return [];
  }
}

/** Parse `WAVE_PICK: Artist - Track || reason` lines from `curateEndlessWaveTracks`. */
export function parseWavePicks(raw: string): WeaselWavePick[] {
  const picks: WeaselWavePick[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^[\s`*_-]*WAVE_PICK:\s*(.+?)\s*\|\|\s*(.+?)\s*[`*_]*$/i.exec(line);
    if (m) {
      const query = m[1].replace(/^[`"'*\s]+|[`"'*\s]+$/g, '').trim();
      const why = m[2].trim();
      if (query && picks.length < 5) {
        picks.push({ query, why });
      }
    }
  }
  return picks;
}

/** Send a message to the Google Cloud Conversational Agent ("Amok" / The Weasel) with full room, memory, and web intelligence. */
export async function askAmokRich(prompt: string, opts: AmokRoomContext): Promise<AmokResult> {
  const trimmed = prompt.trim();
  if (/^(reset|clear|new)$/i.test(trimmed)) {
    resetAmokSession(opts.scopeId, opts.userId);
    return {
      text: "🧹 Right on, buuuddy — wiped the short-term slate totally clean! Fresh vibes, fresh melon. What's shakin'?",
      queueQueries: [],
    };
  }

  const projectId = (process.env.AMOK_PROJECT_ID ?? DEFAULT_PROJECT_ID).trim();
  const location = (process.env.AMOK_LOCATION ?? DEFAULT_LOCATION).trim();
  const agentId = (process.env.AMOK_AGENT_ID ?? DEFAULT_AGENT_ID).trim();

  const { token, quotaProject } = await getAccessToken(projectId);
  const sessionId = amokSessionId(opts.scopeId, opts.userId);
  const host = location === 'global' ? 'dialogflow.googleapis.com' : `${location}-dialogflow.googleapis.com`;
  const url = `https://${host}/v3/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}:detectIntent`;

  const contextNotes: string[] = ['Keep reply ultra-short: 1-2 punchy sentences max (under 40 words)'];
  if (opts.username) {
    contextNotes.push(`Speaker: ${opts.username}`);
  }

  // 1. Long-term user & server memory
  const memSummary = getWeaselMemorySummary(opts.guildId ?? opts.scopeId, opts.userId, opts.username);
  if (memSummary) {
    contextNotes.push(`Long-term memory: ${memSummary}`);
  }

  // 2. Music / Queue / Endless Wave context
  const wantsMusicContext =
    opts.forceRoomContext ||
    /\b(playing|song|track|music|queue|queued|listening|tune|jam|vibe|roast|rate|dj|djs|who queued|leaderboard|stats|sample|sampled|producer|breakdown|lore|wave|autoplay)\b/i.test(
      trimmed,
    );

  if (wantsMusicContext) {
    if (opts.nowPlaying) {
      contextNotes.push(`Currently playing in Discord voice channel: ${opts.nowPlaying}`);
    } else {
      contextNotes.push('Currently playing in Discord voice channel: nothing right now');
    }
    if (opts.upcomingQueue && opts.upcomingQueue.length > 0) {
      contextNotes.push(`Upcoming queue: ${opts.upcomingQueue.slice(0, 8).join('; ')}`);
    }
    if (opts.ewSteerDirective) {
      contextNotes.push(`Active Endless Wave AI direction: ${opts.ewSteerDirective}`);
    }
    if (opts.leaderboardSummary) {
      contextNotes.push(`Server DJ stats: ${opts.leaderboardSummary}`);
    }
  }

  // 3. "Read the Room" — voice channel presence + recent channel chat
  if (opts.voiceMembers && opts.voiceMembers.length > 0) {
    contextNotes.push(`Currently hanging out in the voice channel: ${opts.voiceMembers.join(', ')}`);
  }
  if (opts.recentChat && opts.recentChat.length > 0) {
    contextNotes.push(`Recent channel messages: ${opts.recentChat.slice(-10).join(' // ')}`);
  }

  // 4. Live Google Search web grounding
  if (shouldGroundOnWeb(trimmed)) {
    const facts = await fetchLiveWebFacts(trimmed, projectId, token, quotaProject);
    if (facts) {
      contextNotes.push(`Live web facts as of today: ${facts}`);
    }
  }

  // Background non-blocking learning from what the user said
  if (opts.username) {
    void maybeExtractUserFact(opts.guildId ?? opts.scopeId, opts.userId, opts.username, trimmed);
  }

  let text = trimmed;
  if (contextNotes.length > 0) {
    text = `${trimmed}\n(${contextNotes.join(' | ')})`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-goog-user-project': quotaProject,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      queryInput: {
        text: { text },
        languageCode: 'en',
      },
    }),
    signal: AbortSignal.timeout(25_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Amok agent HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as DetectIntentResponse;
  const rawReply = extractAmokReply(data);
  if (!rawReply) {
    return {
      text: 'Whoa buuuddy, my brain totally spaced out for a sec! Hit me with that again, broham!',
      queueQueries: [],
    };
  }
  const parsed = parseWeaselResponse(rawReply);
  const finalText = parsed.text || rawReply;
  return {
    text: finalText.length > 1800 ? `${finalText.slice(0, 1799)}…` : finalText,
    queueQueries: parsed.queueQueries,
  };
}

/** Backwards-compatible string helper around `askAmokRich`. */
export async function askAmok(prompt: string, opts: AmokRoomContext): Promise<string> {
  const res = await askAmokRich(prompt, opts);
  return res.text;
}
