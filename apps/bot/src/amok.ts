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

const DEFAULT_PROJECT_ID = 'projbdgr';
const DEFAULT_LOCATION = 'global';
const DEFAULT_AGENT_ID = '3762bcaf-20c6-404b-a94b-4803b3b09213';

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

/** Send a message to the Google Cloud Conversational Agent ("Amok" / The Weasel). */
export async function askAmok(
  prompt: string,
  opts: { scopeId: string; userId: string; nowPlaying?: string | null },
): Promise<string> {
  const trimmed = prompt.trim();
  if (/^(reset|clear|new)$/i.test(trimmed)) {
    resetAmokSession(opts.scopeId, opts.userId);
    return "🧹 Right on, buuuddy — wiped the slate totally clean! Fresh vibes, fresh melon. What's shakin'?";
  }

  const projectId = (process.env.AMOK_PROJECT_ID ?? DEFAULT_PROJECT_ID).trim();
  const location = (process.env.AMOK_LOCATION ?? DEFAULT_LOCATION).trim();
  const agentId = (process.env.AMOK_AGENT_ID ?? DEFAULT_AGENT_ID).trim();

  const { token, quotaProject } = await getAccessToken(projectId);
  const sessionId = amokSessionId(opts.scopeId, opts.userId);
  const host = location === 'global' ? 'dialogflow.googleapis.com' : `${location}-dialogflow.googleapis.com`;
  const url = `https://${host}/v3/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}:detectIntent`;

  let text = trimmed;
  if (opts.nowPlaying && /\b(playing|song|track|music|queue|listening|tune|jam|vibe)\b/i.test(trimmed)) {
    text = `${trimmed}\n[Context: Currently playing in the Discord voice channel: ${opts.nowPlaying}]`;
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
  const reply = extractAmokReply(data);
  if (!reply) {
    return 'Whoa buuuddy, my brain totally spaced out for a sec! Hit me with that again, broham!';
  }
  return reply.length > 1950 ? `${reply.slice(0, 1949)}…` : reply;
}
