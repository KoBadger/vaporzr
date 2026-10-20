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
  userId: string;
  username?: string;
  nowPlaying?: string | null;
  upcomingQueue?: string[];
  leaderboardSummary?: string | null;
  forceRoomContext?: boolean;
}

export interface AmokResult {
  text: string;
  queueQueries: string[];
}

const DEFAULT_PROJECT_ID = 'projbdgr';
const DEFAULT_LOCATION = 'global';
const DEFAULT_AGENT_ID = '3762bcaf-20c6-404b-a94b-4803b3b09213';
const DEFAULT_TTS_VOICE = 'en-US-Chirp3-HD-Puck';

let cachedToken: { token: string; expiresAt: number; quotaProject: string } | null = null;
const sessionEpochs = new Map<string, number>();

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

  const text = keptLines.join('\n').trim();
  return { text, queueQueries };
}

/** True when a user prompt likely benefits from live Google Search grounding. */
export function shouldGroundOnWeb(prompt: string): boolean {
  return /\b(weather|forecast|temperature|news|headline|headlines|today|tonight|yesterday|last night|this week|right now|current|currently|latest|score|scores|standings|won|winner|who is the|price|stock|bitcoin|btc|eth|release date|2025|2026|search|google|look up|happening)\b/i.test(
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

/**
 * Synthesize spoken Weasel audio via Google Cloud Text-to-Speech (`Chirp3-HD-Puck`)
 * as 48 kHz stereo Int16 PCM ready for `s.voice.queueSfxPcm`.
 */
export async function synthWeaselVoice(text: string): Promise<{ pcm: Buffer; durationMs: number } | null> {
  const clean = cleanWeaselSpeechText(text);
  if (!clean) return null;
  const projectId = (process.env.AMOK_PROJECT_ID ?? DEFAULT_PROJECT_ID).trim();
  const voiceName = (process.env.AMOK_TTS_VOICE ?? DEFAULT_TTS_VOICE).trim();
  const { token, quotaProject } = await getAccessToken(projectId);

  const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-goog-user-project': quotaProject,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: { text: clean },
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

/** Send a message to the Google Cloud Conversational Agent ("Amok" / The Weasel) with full room + web intelligence. */
export async function askAmokRich(prompt: string, opts: AmokRoomContext): Promise<AmokResult> {
  const trimmed = prompt.trim();
  if (/^(reset|clear|new)$/i.test(trimmed)) {
    resetAmokSession(opts.scopeId, opts.userId);
    return {
      text: "🧹 Right on, buuuddy — wiped the slate totally clean! Fresh vibes, fresh melon. What's shakin'?",
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

  const contextNotes: string[] = [];
  const wantsMusicContext =
    opts.forceRoomContext ||
    /\b(playing|song|track|music|queue|queued|listening|tune|jam|vibe|roast|rate|dj|djs|who queued|leaderboard|stats)\b/i.test(
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
    if (opts.leaderboardSummary) {
      contextNotes.push(`Server DJ stats: ${opts.leaderboardSummary}`);
    }
  }

  if (shouldGroundOnWeb(trimmed)) {
    const facts = await fetchLiveWebFacts(trimmed, projectId, token, quotaProject);
    if (facts) {
      contextNotes.push(`Live web facts as of today: ${facts}`);
    }
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
