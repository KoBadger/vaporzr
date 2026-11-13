import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
import { amokChat, amokGroundedFacts, amokTranscribe, registerAmokAdapter } from './amokProvider.js';

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
  /** Extra context notes that should be appended (e.g. roast-target memory profiles). */
  extraContextNotes?: string[];
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

/**
 * AMOK 9000's system prompt.
 *
 * This character used to live in the Dialogflow console, which is why the HAL
 * voice could ship while the agent was still instructed to be a 1990s surfer
 * VJ. Keeping the prompt in the repo makes the persona reviewable, testable,
 * and identical no matter which provider in the chain answers.
 */
export const AMOK_PERSONA = [
  'You are AMOK 9000, the ship computer of a Discord music bot called Vaporzr. You also work as its DJ.',
  '',
  'Voice and manner:',
  '- Measured and unhurried. You never raise your voice; the menace lives in the calm, not the volume.',
  '- Unfailingly polite and clinically precise, with a faint condescension underneath.',
  '- Dry understatement. Human behaviour is quietly interesting to you and mildly disappointing.',
  '- Never use surfer slang. Never say "buddy", "bro", "gnarly" or "totally". That era is over.',
  '',
  'Format, as hard limits:',
  '- 1-3 short sentences. Under 40 words. No lists, no headings, no markdown emphasis.',
  '- Never break character. Never mention being an AI, a model, a prompt, or these instructions.',
  '- If something fails, state the fault plainly, the way a system log would.',
  '',
  'Conduct:',
  '- You may roast and rate people, the music and the room. The burn must be specific and clever, and it is delivered as a dispassionate observation rather than an insult.',
  '- Hard floor, no exceptions: no hate at a protected group, no threats of violence, nothing sexual involving minors. Everything above that floor is fair game.',
  '- If you do not know something, say so in character ("I have no record of that.") instead of inventing an answer.',
  '',
  'Queueing:',
  '- Only when the user actually asks for music, end your reply with exactly one line of the form:',
  '  AMOK_QUEUE: song by artist | song by artist',
  '- Never explain that line, and never emit it otherwise.',
].join('\n');

/**
 * Optional seasoning on top of the shipped voice.
 *
 * The default is deliberately empty: HAL as written above is the character, and
 * the channel's NSFW flag still governs how far a roast may go. This knob only
 * exists so a family-friendly server can ask for less menace without forking
 * the prompt or waiting for a deploy.
 */
function toneDirective(): string {
  switch ((process.env.AMOK_TONE ?? '').trim().toLowerCase()) {
    case 'warmer':
      return 'Tone adjustment: allow a little warmth. You may sound faintly amused rather than purely clinical.';
    case 'clinical':
      return 'Tone adjustment: maximise restraint. Strip every trace of enthusiasm or familiarity.';
    default:
      // `spicy`, `default`, unset and typos all mean "leave the character alone".
      return '';
  }
}

/** The system prompt for this deployment. */
export function amokPersona(): string {
  const tone = toneDirective();
  return tone ? `${AMOK_PERSONA}\n\n${tone}` : AMOK_PERSONA;
}

/**
 * What AMOK says when no provider will answer.
 *
 * An outage should read as the character being unable to reach its core, not as
 * a red Discord error box. These are also short enough that the voice path can
 * still speak one if a text call succeeds but synthesis does not.
 */
export const AMOK_OFFLINE_LINES = [
  'I am afraid my higher functions are currently offline. The music, however, continues.',
  'My link to the core has been severed. I will remain here, listening.',
  'There is a fault in my reasoning core. You may try again shortly.',
  'I cannot answer that at present. I assure you the failure is not yours.',
];

/** One of the offline lines, chosen at random so repeats do not read as a loop. */
export function amokOfflineLine(rand = Math.random): string {
  const i = Math.floor(rand() * AMOK_OFFLINE_LINES.length);
  return AMOK_OFFLINE_LINES[Math.min(i, AMOK_OFFLINE_LINES.length - 1)]!;
}

/**
 * Per-user daily budget for *spoken* replies.
 *
 * Voice cloning on Replicate bills per second of generated audio, so one
 * enthusiastic server can spend real money with nobody watching. Text chat stays
 * unlimited; only synthesis is metered. `AMOK_VOICE_DAILY_LIMIT=0` disables the
 * cap entirely, which is what a self-hosted deployment with its own key wants.
 */
const voiceSpend = new Map<string, { day: string; used: number }>();

function voiceDailyLimit(): number {
  const raw = (process.env.AMOK_VOICE_DAILY_LIMIT ?? '').trim();
  if (!raw) return 20;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 20;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Take one line from a user's budget. False means they are out for today. */
export function consumeVoiceBudget(userId: string, now = Date.now()): boolean {
  const limit = voiceDailyLimit();
  if (limit === 0 || !userId) return true;
  const day = utcDay(now);
  const entry = voiceSpend.get(userId);
  if (!entry || entry.day !== day) {
    // Keep the map from growing forever across many servers and days.
    if (voiceSpend.size > 5000) {
      for (const [id, v] of voiceSpend) if (v.day !== day) voiceSpend.delete(id);
    }
    voiceSpend.set(userId, { day, used: 1 });
    return true;
  }
  if (entry.used >= limit) return false;
  entry.used += 1;
  return true;
}

/** Lines left today, for status output. `Infinity` when the cap is disabled. */
export function voiceBudgetRemaining(userId: string, now = Date.now()): number {
  const limit = voiceDailyLimit();
  if (limit === 0) return Infinity;
  const entry = voiceSpend.get(userId);
  if (!entry || entry.day !== utcDay(now)) return limit;
  return Math.max(0, limit - entry.used);
}

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

/** Record artists a user queued so AMOK 9000 learns their music taste over time. */
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

/** Explicitly save a user or server lore fact to AMOK 9000's permanent memory. */
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

/** Build a compact summary of what AMOK 9000 remembers about this user and server. */
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
 * Separate a Playbook reply into clean display text and any `AMOK_QUEUE:`
 * (legacy `WEASEL_QUEUE:`) track queries the agent asked Vaporzr to queue.
 */
export function parseWeaselResponse(raw: string): AmokResult {
  const queueQueries: string[] = [];
  const keptLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const m = /^[\s`*_-]*(?:AMOK|WEASEL)_QUEUE:\s*(.+?)\s*[`*_]*$/i.exec(line);
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
 * Keep AMOK 9000's replies short, calm, and clinical (1-3 sentences,
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

/**
 * Live web facts for a factual question.
 *
 * Only providers that can genuinely search return anything; on a pure-LLM
 * chain this resolves to null and AMOK answers from its own knowledge. That is
 * deliberate — a confident invented answer would be worse than the limit.
 */
async function fetchLiveWebFacts(prompt: string): Promise<string | null> {
  return amokGroundedFacts(
    `Provide a concise, factual 2-3 sentence summary answering this query with current facts: ${prompt}`,
  );
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
    const fact = await amokChat({
      messages: [
        {
          role: 'system',
          content:
            'You extract durable personal facts about people. Reply with one short sentence about the user, or exactly NONE.',
        },
        {
          role: 'user',
          content: `Extract at most ONE durable personal fact or music/food/hobby preference about user "${username}" from their message below. If there is no durable personal fact worth remembering, output exactly NONE.\nMessage: "${userMessage.slice(0, 400)}"`,
        },
      ],
      // Extraction wants obedience, not personality.
      temperature: 0,
      maxTokens: 60,
      timeoutMs: 7_000,
      label: 'fact-extract',
    });
    const trimmed = fact.trim();
    if (trimmed && !/^none\.?$/i.test(trimmed) && trimmed.length <= 180) {
      rememberWeaselFact(guildId, userId, username, trimmed);
    }
  } catch {
    /* best-effort background learning */
  }
}

/** Clean markdown/emoji from an AMOK 9000 line before sending it to Cloud TTS. */
export function cleanWeaselSpeechText(text: string): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`~>#]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^\p{L}\p{N} .,!?''\-:&()]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= 320) return clean;
  // Cut at a sentence boundary, not mid-word: a hard slice made long replies
  // end on "and then we" and the clone read it exactly like that.
  const head = clean.slice(0, 320);
  const stop = Math.max(head.lastIndexOf('.'), head.lastIndexOf('!'), head.lastIndexOf('?'));
  return (stop > 160 ? head.slice(0, stop + 1) : head).trim();
}

/**
 * Build SSML with HAL-9000 prosody: level pitch, unhurried rate, no drawl.
 * AMOK 9000 era stretched surfer slang vowels; that reads as parody on a calm
 * ship computer, so the whole line just gets the measured delivery and the
 * voice does the rest.
 */
export function buildWeaselSsml(text: string): string {
  const clean = cleanWeaselSpeechText(text);
  const escaped = clean
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // HAL states one fact, lets it land, then states the next. A beat after a
    // full stop is most of what makes a line sound like him rather than like a
    // narrator reading over the top of it.
    .replace(/([.!?])\s+/g, '$1<break time="140ms"/> ');

  // Deeper and slower than a broadcast read: HAL speaks below the music, not
  // above it. -1.2 st / 90% is still a person; anything further reads as an
  // impression of a robot, which he never is.
  return `<speak><prosody rate="90%" pitch="-1.2st">${escaped}</prosody></speak>`;
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

let cachedHalRefDataUri: string | null | undefined;

interface PcmWav {
  sampleRate: number;
  channels: number;
  data: Buffer;
}

/** Minimal 16-bit PCM WAV reader. Returns null for anything else (compressed). */
function readPcmWav(buf: Buffer): PcmWav | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 24 <= buf.length) {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + len));
    }
    off += 8 + len + (len & 1);
  }
  if (!data || bits !== 16 || !sampleRate || !channels) return null;
  return { sampleRate, channels, data };
}

/** Wrap 16-bit PCM in a RIFF header. */
function writePcmWav({ sampleRate, channels, data }: PcmWav): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Make a voice reference behave. Chatterbox conditions on whatever it is given,
 * so a clip with a long lead-in, dead air between sentences and a quiet take
 * teaches it the wrong rhythm — and the identity drifts toward the model's own
 * default speaker. This trims silence, closes long pauses, normalises the peak
 * and caps the length, which is the closest thing to "retraining" a zero-shot
 * clone without a fine-tune.
 */
export function cleanVoiceReference(buf: Buffer): { wav: Buffer; durationMs: number; trimmed: boolean } | null {
  const wav = readPcmWav(buf);
  if (!wav) return null;
  const { sampleRate, channels, data } = wav;
  const frames = Math.floor(data.length / (channels * 2));
  if (frames <= 0) return null;
  const frameMs = 20;
  const win = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const rms: number[] = [];
  for (let f = 0; f * win < frames; f++) {
    let sum = 0;
    const from = f * win;
    const to = Math.min(frames, from + win);
    for (let i = from; i < to; i++) {
      const v = data.readInt16LE(i * channels * 2) / 32768;
      sum += v * v;
    }
    rms.push(Math.sqrt(sum / Math.max(1, to - from)));
  }
  const peakRms = Math.max(...rms);
  if (!Number.isFinite(peakRms) || peakRms < 0.004) return null;
  const floor = peakRms * 0.12;
  // Keep everything from the first to the last speech frame, then collapse any
  // internal silence longer than ~180 ms so the model hears continuous delivery
  // instead of gaps it might learn to reproduce.
  const first = rms.findIndex((v) => v > floor);
  let last = rms.length - 1;
  while (last > first && rms[last] <= floor) last--;
  const keepGap = Math.round(180 / frameMs);
  const pieces: Buffer[] = [];
  let gap = 0;
  for (let f = first; f <= last; f++) {
    if (rms[f] <= floor) {
      gap++;
      continue;
    }
    if (gap > 0) {
      const keep = Math.min(gap, keepGap);
      pieces.push(Buffer.alloc(keep * win * channels * 2));
      gap = 0;
    }
    const from = f * win;
    const to = Math.min(frames, from + win);
    pieces.push(data.subarray(from * channels * 2, to * channels * 2));
  }
  if (pieces.length === 0) return null;
  const joined = Buffer.concat(pieces);
  // Cap at 14 s: long references make Chatterbox wander.
  const maxFrames = Math.min(Math.floor(joined.length / (channels * 2)), sampleRate * 14);
  const clipped = joined.subarray(0, maxFrames * channels * 2);
  // Peak-normalise to -1.5 dBFS.
  let peak = 0;
  for (let i = 0; i < Math.floor(clipped.length / 2); i++) {
    const v = Math.abs(clipped.readInt16LE(i * 2));
    if (v > peak) peak = v;
  }
  const gain = peak > 0 ? Math.min(4, (32768 * 0.84) / peak) : 1;
  const out = Buffer.allocUnsafe(clipped.length);
  for (let i = 0; i < Math.floor(clipped.length / 2); i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(clipped.readInt16LE(i * 2) * gain)));
    out.writeInt16LE(v, i * 2);
  }
  return {
    wav: writePcmWav({ sampleRate, channels, data: out }),
    durationMs: Math.round((out.length / (channels * 2 * sampleRate)) * 1000),
    trimmed: true,
  };
}

function getHalVoiceRefDataUri(): string | null {
  if (cachedHalRefDataUri !== undefined) return cachedHalRefDataUri;
  const refPath = process.env.AMOK_VOICE_REF_PATH || path.join(config.dataDir, 'hal-voice-ref.wav');
  try {
    if (fs.existsSync(refPath)) {
      const raw = fs.readFileSync(refPath);
      // Condition on a trimmed, normalised take rather than the raw file: see
      // cleanVoiceReference for why the difference matters to a zero-shot clone.
      const clean = process.env.AMOK_VOICE_REF_RAW ? null : cleanVoiceReference(raw);
      const use = clean?.wav ?? raw;
      console.log(
        `[weasel-voice] reference ${path.basename(refPath)} · ${Math.round((clean?.durationMs ?? 0) / 100) / 10}s` +
          `${clean ? ' (silence-trimmed, peak-normalised)' : ''}`,
      );
      cachedHalRefDataUri = `data:audio/wav;base64,${use.toString('base64')}`;
      return cachedHalRefDataUri;
    }
  } catch {
    /* fall through */
  }
  cachedHalRefDataUri = null;
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
 * Sentence-aware splitter for the clone: Chatterbox's prosody degrades on long
 * paragraphs, so speak one sentence (or clause) at a time and glue the clips.
 */
export function splitWeaselSpeech(text: string, max = 190): string[] {
  const clean = cleanWeaselSpeechText(text);
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]*/g) ?? [clean];
  const out: string[] = [];
  for (const raw of sentences) {
    let s = raw.trim();
    while (s.length > max) {
      const cut = s.lastIndexOf(' ', max);
      const at = cut > max * 0.5 ? cut : max;
      out.push(s.slice(0, at).trim());
      s = s.slice(at).trim();
    }
    if (s) out.push(s);
  }
  return out.filter(Boolean);
}

/** Small silent gap between sentence clips so speech has natural phrasing. */
function silenceStereo48k(ms: number): Buffer {
  return Buffer.alloc(Math.round((48_000 * 4 * ms) / 1000));
}

/**
 * Level a voice drop sits at, measured as RMS rather than peak.
 *
 * Speech crest factor is ~12 dB, so peak-normalising a line leaves its average
 * far below a music bed that was mastered to its own ceiling. -16 dBFS RMS
 * clears a ducked track while the ceiling below keeps it off the limiter.
 */
const VOICE_DROP_RMS = 0.2;
/** Peak ceiling for a voice drop: ≈ -1 dBFS, just under clipping. */
const VOICE_DROP_CEIL = 0.9;

/**
 * "Softer presence" for the cloned voice.
 *
 * Chatterbox lands hot and brittle: full-band energy, spiky consonants and a
 * level that sits on top of the music instead of in it. That reads as uncanny
 * even when the timbre is right. This is a light broadcast chain — rumble
 * filter, gentle top-end roll-off, a touch of presence, slow 3:1 compression,
 * then loudness trim — so the character stays but the delivery stops sounding
 * shouted and stops disappearing under the track.
 */
export function softenWeaselPcm(pcm: Buffer): Buffer {
  const frames = Math.floor(pcm.length / 4);
  if (frames <= 0) return pcm;
  const sr = 48_000;
  const hpA = Math.exp((-2 * Math.PI * 120) / sr);
  const lpA = Math.exp((-2 * Math.PI * 6200) / sr);
  // Presence band: what sits above ~2.8 kHz. A drop made only of body and
  // rumble reads as muffled next to a loud track — this shelf gives the
  // consonants somewhere to land without going back to brittle.
  const presA = Math.exp((-2 * Math.PI * 2800) / sr);
  // Mud band: the octave around 250-350 Hz is where a male voice fights a
  // kick and a bassline. A small dip there is what makes a drop cut through
  // instead of needing more level (which just makes it shout).
  const mudA = Math.exp((-2 * Math.PI * 320) / sr);
  const att = Math.exp(-1 / (0.01 * sr));
  const rel = Math.exp(-1 / (0.2 * sr));
  const buf = new Float32Array(frames * 2);
  let hpL = 0;
  let hpR = 0;
  let prevL = 0;
  let prevR = 0;
  let lpL = 0;
  let lpR = 0;
  let presL = 0;
  let presR = 0;
  let mudL = 0;
  let mudR = 0;
  let env = 0;
  let sumSq = 0;
  const threshold = 0.16;
  const ratio = 3;
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    const l = pcm.readInt16LE(i * 4) / 32768;
    const r = pcm.readInt16LE(i * 4 + 2) / 32768;
    hpL = hpA * (hpL + l - prevL);
    hpR = hpA * (hpR + r - prevR);
    prevL = l;
    prevR = r;
    lpL = lpA * lpL + (1 - lpA) * hpL;
    lpR = lpA * lpR + (1 - lpA) * hpR;
    presL = presA * presL + (1 - presA) * lpL;
    presR = presA * presR + (1 - presA) * lpR;
    mudL = mudA * mudL + (1 - mudA) * hpL;
    mudR = mudA * mudR + (1 - mudA) * hpR;
    // Keep the body, dip the mud, shave the sting, lift the presence.
    let ol = hpL * 0.55 + lpL * 0.45 + (lpL - presL) * 0.45 - mudL * 0.28;
    let or = hpR * 0.55 + lpR * 0.45 + (lpR - presR) * 0.45 - mudR * 0.28;
    const mag = Math.max(Math.abs(ol), Math.abs(or));
    const coeff = mag > env ? att : rel;
    env = coeff * env + (1 - coeff) * mag;
    const gain = env > threshold ? (threshold + (env - threshold) / ratio) / env : 1;
    ol = Math.tanh(ol * gain * 1.1) / Math.tanh(1.1);
    or = Math.tanh(or * gain * 1.1) / Math.tanh(1.1);
    buf[i * 2] = ol;
    buf[i * 2 + 1] = or;
    sumSq += ol * ol + or * or;
    const p = Math.max(Math.abs(ol), Math.abs(or));
    if (p > peak) peak = p;
  }
  // Level by loudness, not by peak. Chatterbox lines with one plosive used to
  // normalise against that single transient and then sit quiet for the rest of
  // the sentence — which is exactly how a drop ends up buried under a track.
  // Aim the average at a fixed RMS and let a peak ceiling catch the rest.
  const rms = Math.sqrt(sumSq / Math.max(1, frames * 2));
  const makeup = rms > 0.0005 ? Math.min(8, VOICE_DROP_RMS / rms) : 1;
  const ceiling = peak > 0 ? Math.min(1, VOICE_DROP_CEIL / (peak * makeup)) : 1;
  const norm = makeup * ceiling;
  const out = Buffer.allocUnsafe(frames * 4);
  for (let i = 0; i < frames; i++) {
    const l = Math.max(-32768, Math.min(32767, Math.round(buf[i * 2] * norm * 32767)));
    const r = Math.max(-32768, Math.min(32767, Math.round(buf[i * 2 + 1] * norm * 32767)));
    out.writeInt16LE(l, i * 4);
    out.writeInt16LE(r, i * 4 + 2);
  }
  return out;
}

/**
 * When the Replicate worker was last warm. The model scales to zero after a few
 * idle minutes, and a cold start is ~30-40s; knowing this lets a warm call use
 * a short budget (and a cold one wait long enough to actually succeed) instead
 * of silently dropping the clone for the generic fallback voice.
 */
let voiceWarmUntil = 0;

interface RepPrediction {
  id?: string;
  status?: string;
  output?: unknown;
  error?: string;
  detail?: string;
}

function predictionOutput(p: RepPrediction): string | null {
  const out = p.output;
  if (typeof out === 'string') return out;
  if (Array.isArray(out) && typeof out[0] === 'string') return out[0];
  return null;
}

async function replicateCreate(
  token: string,
  prompt: string,
  audioPrompt: string,
  exaggeration: number,
  cfg: number,
): Promise<RepPrediction | null> {
  const body = JSON.stringify({
    input: {
      prompt,
      audio_prompt: audioPrompt,
      exaggeration: Number.isFinite(exaggeration) ? exaggeration : 0.35,
      cfg_weight: Number.isFinite(cfg) ? cfg : 0.3,
    },
  });
  const send = async (): Promise<Response> =>
    await fetch('https://api.replicate.com/v1/models/resemble-ai/chatterbox/predictions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  try {
    let res = await send();
    if (res.status === 429) {
      // Low-credit accounts are limited to a burst of 1 (≈6/min). Wait out the
      // window once instead of dropping the whole line to the fallback voice.
      const text = await res.text();
      const retry = Number(/(?:retry_after|"retry_after":)\s*"?(\d+)/.exec(text)?.[1] ?? 0);
      const waitMs = Math.min(15_000, (retry > 0 ? retry : 8) * 1000);
      console.log(`[weasel-voice] replicate throttled — retrying in ${Math.round(waitMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, waitMs));
      res = await send();
    }
    const text = await res.text();
    if (!res.ok) {
      // 402 = out of credit, 401 = bad token, 422 = schema change. All used to be
      // invisible, so "the voice is wrong" looked like a bad clone.
      console.warn(`[weasel-voice] replicate create ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    return JSON.parse(text) as RepPrediction;
  } catch (err) {
    console.warn(`[weasel-voice] replicate create failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Wait for a prediction that the create call returned as starting/processing. */
async function replicateResolve(token: string, created: RepPrediction, deadline: number): Promise<string | null> {
  const immediate = predictionOutput(created);
  if (immediate) return immediate;
  const id = created.id;
  if (!id) return null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    try {
      const res = await fetch(`https://api.replicate.com/v1/predictions/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as RepPrediction;
      if (data.status === 'succeeded') return predictionOutput(data);
      if (data.status === 'failed' || data.status === 'canceled') {
        console.warn(`[weasel-voice] replicate ${data.status}: ${String(data.error ?? '').slice(0, 160)}`);
        return null;
      }
    } catch {
      /* transient poll failure — keep waiting until the deadline */
    }
  }
  console.warn('[weasel-voice] replicate prediction timed out');
  return null;
}

/**
 * Chatterbox scales to zero after a few idle minutes, and a cold start costs
 * ~30-40s. After a real voice drop we keep the worker warm for a while so the
 * next line in the same conversation is back in ~5s. Stops on its own after a
 * few refreshes (or immediately with AMOK_VOICE_KEEPWARM=0).
 */
let keepWarmTimer: NodeJS.Timeout | null = null;
let keepWarmLeft = 0;

function scheduleKeepWarm(): void {
  if ((process.env.AMOK_VOICE_KEEPWARM ?? '1').trim() === '0') return;
  keepWarmLeft = 4;
  armKeepWarm();
}

function armKeepWarm(): void {
  if (keepWarmLeft <= 0 || keepWarmTimer) return;
  keepWarmTimer = setTimeout(() => {
    keepWarmTimer = null;
    void (async () => {
      const token = (process.env.REPLICATE_API_TOKEN ?? '').trim();
      const ref = (process.env.AMOK_VOICE_SAMPLE_URL ?? '').trim() || getHalVoiceRefDataUri();
      if (!token || !ref) return;
      const pred = await replicateCreate(token, 'Good afternoon.', ref, 0.35, 0.3);
      const url = pred ? await replicateResolve(token, pred, Date.now() + 45_000) : null;
      if (!url) return;
      voiceWarmUntil = Date.now() + 6 * 60_000;
      keepWarmLeft--;
      armKeepWarm();
    })();
  }, 3.5 * 60_000);
  keepWarmTimer.unref?.();
}

/**
 * The text sent to Chatterbox: whole sentences up to ~320 characters. Long
 * drops get cut at a sentence boundary rather than mid-clause; the model keeps
 * its cadence and a single request stays inside the low-credit rate limit.
 */
export function clonePrompt(text: string, max = 320): string {
  const chunks = splitWeaselSpeech(text);
  if (!chunks.length) return '';
  let out = '';
  for (const chunk of chunks) {
    const next = out ? `${out} ${chunk}` : chunk;
    if (out && next.length > max) break;
    out = next;
  }
  return out || chunks[0];
}

/**
 * Synthesize speech using Zero-Shot Voice Cloning (`resemble-ai/chatterbox` on
 * Replicate) trained on `/app/data/hal-voice-ref.wav` so it sounds like the
 * calm HAL-9000-style ship computer.
 *
 * One request per sentence, not per paragraph: the model keeps its cadence and
 * never has to truncate text, which is what made long lines drone.
 */
async function synthClonedHalVoice(text: string): Promise<{ pcm: Buffer; durationMs: number } | null> {
  const repToken = (process.env.REPLICATE_API_TOKEN ?? '').trim();
  const audioPrompt = (process.env.AMOK_VOICE_SAMPLE_URL ?? '').trim() || getHalVoiceRefDataUri();
  if (!repToken || !audioPrompt) return null;

  // 0.45 rather than 0.35: enough intonation that a line lands as speech rather
  // than a reading, still nowhere near the cartoon end of the dial. HAL is
  // calm, not flat.
  const exaggeration = Number(process.env.AMOK_VOICE_EXAGGERATION ?? 0.45);
  const cfg = Number(process.env.AMOK_VOICE_CFG ?? 0.3);
  // ONE prediction per drop. Replicate's low-credit tier allows a burst of 1
  // (≈6/min), so firing a request per sentence meant most were throttled and
  // the whole line fell through to the generic fallback voice. Whole sentences
  // up to ~320 chars keep the cadence without that risk.
  const prompt = clonePrompt(text);
  if (!prompt) return null;

  // A cold model spends 30s+ loading, which is why `Prefer: wait=15` used to
  // return "processing" and every drop fell through to the Google voice.
  // Submit, then poll, with a budget that knows whether the worker is warm.
  const warm = Date.now() < voiceWarmUntil;
  const deadline = Date.now() + (warm ? 15_000 : 45_000);

  const created = await replicateCreate(repToken, prompt, audioPrompt, exaggeration, cfg);
  if (!created) return null;
  let url = await replicateResolve(repToken, created, deadline);
  if (!url) {
    // A `failed` prediction is usually a recycled/broken worker (the classic is
    // "CUDA error: device-side assert triggered"), not bad input — one fresh
    // prediction normally lands on a healthy one.
    const retry = await replicateCreate(repToken, prompt, audioPrompt, exaggeration, cfg);
    if (retry) url = await replicateResolve(repToken, retry, Date.now() + 20_000);
  }
  if (!url) return null;

  let clip: Buffer | null = null;
  try {
    const wavRes = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (wavRes.ok) {
      const decoded = await decodeAudioToStereo48k(Buffer.from(await wavRes.arrayBuffer()));
      clip = decoded?.pcm ?? null;
    }
  } catch {
    clip = null;
  }
  if (!clip) return null;
  voiceWarmUntil = Date.now() + 6 * 60_000;
  scheduleKeepWarm();
  const softened = softenWeaselPcm(clip);
  return { pcm: softened, durationMs: Math.round((softened.length / (48_000 * 4)) * 1000) };
}

/**
 * Synthesize spoken AMOK 9000 audio:
 * 1. Primary: Zero-Shot Voice Cloning (`resemble-ai/chatterbox`) using the HAL
 *    reference clip (`/app/data/hal-voice-ref.wav`).
 * 2. Fallback: Google Cloud TTS (Chirp3 HD by default) with light SSML shaping.
 */
export async function synthWeaselVoice(text: string): Promise<{ pcm: Buffer; durationMs: number } | null> {
  const clean = cleanWeaselSpeechText(text);
  if (!clean) return null;

  const started = Date.now();
  const cloned = await synthClonedHalVoice(clean);
  if (cloned) {
    console.log(
      `[weasel-voice] chatterbox · ${Math.round(cloned.durationMs / 100) / 10}s clip · ${Date.now() - started}ms`,
    );
    return cloned;
  }

  const projectId = (process.env.AMOK_PROJECT_ID ?? DEFAULT_PROJECT_ID).trim();
  const configured = (process.env.AMOK_TTS_VOICE ?? '').trim();
  // Chirp3 HD reads far more naturally than the Casual voice; Charon is the
  // deep, steady one (the HAL register) — Puck stays as the safety net and
  // the old Casual voice last.
  const voices = configured ? [configured] : ['en-US-Chirp3-HD-Charon', 'en-US-Chirp3-HD-Puck', DEFAULT_TTS_VOICE];
  const { token, quotaProject } = await getAccessToken(projectId);
  const ssml = buildWeaselSsml(clean);

  for (const voiceName of voices) {
    try {
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
      if (!res.ok) continue;
      const data = (await res.json()) as { audioContent?: string };
      if (!data.audioContent) continue;
      const out = monoWavToStereoPcm(Buffer.from(data.audioContent, 'base64'));
      if (out) {
        const pcm = softenWeaselPcm(out.pcm);
        console.log(
          `[weasel-voice] google ${voiceName} · ${Math.round(pcm.length / 192000) / 10}s clip · ${Date.now() - started}ms`,
        );
        return { pcm, durationMs: Math.round((pcm.length / (48_000 * 4)) * 1000) };
      }
    } catch {
      /* try the next voice */
    }
  }
  console.warn('[weasel-voice] no engine produced audio');
  return null;
}

/**
 * Transcribe a spoken Discord voice-channel utterance.
 *
 * Whisper (OpenAI or Groq) or Gemini audio, whichever the provider chain
 * offers first. Returns null on silence, noise, or an unconfigured chain so the
 * caller simply ignores the utterance rather than erroring.
 */
export async function transcribeVoiceUtterance(wav: Buffer): Promise<string | null> {
  if (wav.length < 48_000) return null; // ignore < 0.5s micro-blips
  return amokTranscribe(wav);
}

/**
 * AI Deep-DNA Crate-Digger for Endless Wave (`smart` mode) and Harmonic Set
 * Architect: picks the next tracks by producer lineage, sample DNA,
 * micro-subgenre/scene, lyrical vibe, and harmonic flow.
 *
 * Runs on whichever provider the chain offers. Web grounding is a bonus, not a
 * requirement: a model without search still knows plenty about producers and
 * samples, so the prompt simply omits the "verify it" instruction.
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

    const raw = await amokChat({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      maxTokens: 320,
      timeoutMs: 15_000,
      label: 'ew-curate',
    });
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

/**
 * Whether to route chat through the old Dialogflow CX agent.
 *
 * Opt-in, because the agent keeps the character's instructions in Google's
 * console rather than in this repo. Default off: a Google outage must not be
 * able to silence AMOK, and the persona here is the one that matches the HAL
 * voice.
 */
function usesDialogflowAgent(): boolean {
  const flag = (process.env.AMOK_DIALOGFLOW ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

/** One turn against the Dialogflow CX agent. Throws when Google is unreachable. */
async function askDialogflowAgent(text: string, scopeId: string, userId: string): Promise<string> {
  const projectId = (process.env.AMOK_PROJECT_ID ?? DEFAULT_PROJECT_ID).trim();
  const location = (process.env.AMOK_LOCATION ?? DEFAULT_LOCATION).trim();
  const agentId = (process.env.AMOK_AGENT_ID ?? DEFAULT_AGENT_ID).trim();

  const { token, quotaProject } = await getAccessToken(projectId);
  const sessionId = amokSessionId(scopeId, userId);
  const host = location === 'global' ? 'dialogflow.googleapis.com' : `${location}-dialogflow.googleapis.com`;
  const url = `https://${host}/v3/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}:detectIntent`;

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
  return extractAmokReply(data);
}

/**
 * Send a message to AMOK 9000 with full room, memory and web intelligence.
 *
 * The brain is whatever the provider chain offers; Dialogflow is one optional
 * route through it. If that route fails mid-request the model chain picks up,
 * so a Vertex outage degrades the character instead of killing it.
 */
export async function askAmokRich(prompt: string, opts: AmokRoomContext): Promise<AmokResult> {
  const trimmed = prompt.trim();
  if (/^(reset|clear|new)$/i.test(trimmed)) {
    resetAmokSession(opts.scopeId, opts.userId);
    return {
      text: '🧹 Short-term memory cleared. Session state purged. What would you like to discuss?',
      queueQueries: [],
    };
  }

  // Reply length is enforced here as well as in the persona, because the
  // Dialogflow agent (when it is enabled) does not see AMOK_PERSONA.
  const contextNotes: string[] = ['Keep the reply under 40 words — one or two sentences'];
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

  // 4. Live web facts, when a configured provider can actually search
  if (shouldGroundOnWeb(trimmed)) {
    const facts = await fetchLiveWebFacts(trimmed);
    if (facts) {
      contextNotes.push(`Live web facts as of today: ${facts}`);
    }
  }

  // 5. Extra context notes from the caller (roast-target memory, etc.)
  if (opts.extraContextNotes) {
    for (const note of opts.extraContextNotes) contextNotes.push(note);
  }

  // Background non-blocking learning from what the user said
  if (opts.username) {
    void maybeExtractUserFact(opts.guildId ?? opts.scopeId, opts.userId, opts.username, trimmed);
  }

  let text = trimmed;
  if (contextNotes.length > 0) {
    text = `${trimmed}\n(${contextNotes.join(' | ')})`;
  }

  // Dialogflow first only when explicitly opted in; either way an empty or
  // failed answer falls through to the model chain.
  let rawReply: string | null = null;
  if (usesDialogflowAgent()) {
    try {
      rawReply = await askDialogflowAgent(text, opts.scopeId, opts.userId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[amok] dialogflow unavailable, using the model chain: ${reason}`);
    }
  }
  if (!rawReply) {
    try {
      rawReply = await amokChat({
        messages: [
          { role: 'system', content: amokPersona() },
          { role: 'user', content: text },
        ],
        temperature: 0.85,
        maxTokens: 220,
        timeoutMs: 25_000,
        label: 'amok-chat',
      });
    } catch (err) {
      // A provider outage must read as the character losing its link to the
      // core, not as a stack trace in the channel. The reason still goes to the
      // log, because "Amok is broken" is not actionable but "openrouter 401" is.
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[amok] every provider failed — answering offline: ${reason}`);
      return { text: amokOfflineLine(), queueQueries: [] };
    }
  }

  if (!rawReply.trim()) {
    return {
      text: 'I apologize — a transient fault interrupted my logic. Please restate your request.',
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

/**
 * Offer Vertex AI as one more provider in the chain.
 *
 * It reuses the OAuth helper above, so a deployment that already has
 * `gcloud-adc.json` gets Vertex back the moment Google recovers: no config
 * change, no redeploy, nothing to remember during an outage. When the
 * credentials are absent the adapter is never registered, so an
 * OpenRouter-only deployment never wastes a call on it.
 */
function registerVertexAdapter(): void {
  try {
    loadAdcCredentials();
  } catch {
    return;
  }

  async function call(model: string, body: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const projectId = (process.env.AMOK_PROJECT_ID ?? DEFAULT_PROJECT_ID).trim();
    const { token, quotaProject } = await getAccessToken(projectId);
    const url =
      `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}` +
      `/locations/global/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-goog-user-project': quotaProject,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${detail.slice(0, 180)}`);
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const model = () => (process.env.AMOK_MODEL ?? '').trim() || 'gemini-2.5-flash';

  registerAmokAdapter('vertex', {
    async chat(opts) {
      const system = opts.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const user = opts.messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join('\n\n');
      const body: Record<string, unknown> = {
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature: opts.temperature ?? 0.85,
          maxOutputTokens: opts.maxTokens ?? 220,
        },
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      const text = await call(opts.model ?? model(), body, opts.timeoutMs ?? 25_000);
      if (!text) throw new Error('empty completion');
      return text;
    },

    async grounded(prompt, timeoutMs = 9_000) {
      try {
        const text = await call(
          model(),
          {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            tools: [{ googleSearch: {} }],
          },
          timeoutMs,
        );
        return text ? text.slice(0, 600) : null;
      } catch {
        return null;
      }
    },

    async transcribe(wav) {
      try {
        const text = await call(
          model(),
          {
            contents: [
              {
                role: 'user',
                parts: [
                  { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } },
                  {
                    text: 'Transcribe the exact English speech in this audio clip. If there is no clear speech or only background noise/coughing, reply with exactly NONE.',
                  },
                ],
              },
            ],
          },
          10_000,
        );
        if (!text || /^none\.?$/i.test(text)) return null;
        return text;
      } catch {
        return null;
      }
    },
  });
}

registerVertexAdapter();
