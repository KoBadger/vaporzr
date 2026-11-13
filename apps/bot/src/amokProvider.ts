/**
 * Model access for AMOK, kept out of `amok.ts`.
 *
 * The Weasel used to be a single hard dependency: a Dialogflow CX agent on
 * Vertex AI, reached with a Google OAuth refresh token. When that project is
 * unavailable (billing, quota, region, an outage) the whole character goes
 * dark - chat, voice recognition, web facts, Endless Wave curation.
 *
 * This module turns "the model" into a swappable thing. Every provider speaks
 * one of three dialects (OpenAI chat-completions, Anthropic Messages, Gemini
 * generateContent), so a new vendor is a handful of lines rather than a
 * rewrite. A provider that has no credentials simply drops out of the chain,
 * and `amokChat` walks the rest until one answers.
 *
 * Configuration (all optional):
 *
 *   AMOK_PROVIDER   openrouter | openai | anthropic | groq | google | vertex
 *   AMOK_MODEL      model id for the primary provider
 *   AMOK_API_KEY    key for the primary provider (else the vendor's own var)
 *   AMOK_FALLBACK   comma-separated providers to try in order
 *
 * Nothing here imports `amok.ts`; the Vertex/Dialogflow adapter is registered
 * from there instead, which keeps the two modules acyclic.
 */

export type AmokProviderName = 'openrouter' | 'openai' | 'anthropic' | 'groq' | 'google' | 'vertex';

export interface AmokChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AmokChatOptions {
  messages: AmokChatMessage[];
  /** Overrides the provider's default model for this call. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Short tag used in logs, e.g. `weasel-chat`. */
  label?: string;
}

/**
 * One provider. `grounded` and `transcribe` are optional because not every
 * vendor offers web search or speech-to-text; when a capability is missing the
 * chain just skips to the next provider that has it.
 */
export interface AmokAdapter {
  chat(opts: AmokChatOptions): Promise<string>;
  /** Web-grounded answer to a factual question, or null when unsupported. */
  grounded?(prompt: string, timeoutMs?: number): Promise<string | null>;
  /** Transcript of a spoken utterance, or null when unsupported/unintelligible. */
  transcribe?(wav: Buffer): Promise<string | null>;
}

const adapters = new Map<string, AmokAdapter>();

/** Register (or replace) a provider. Used by `amok.ts` for the Vertex adapter. */
export function registerAmokAdapter(name: string, adapter: AmokAdapter): void {
  adapters.set(name, adapter);
}

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

/** A vendor's own key. Says nothing about any other vendor. */
function vendorKey(name: string): string {
  switch (name) {
    case 'openrouter':
      return env('OPENROUTER_API_KEY');
    case 'openai':
      return env('OPENAI_API_KEY');
    case 'anthropic':
      return env('ANTHROPIC_API_KEY');
    case 'groq':
      return env('GROQ_API_KEY');
    case 'google':
      return env('GEMINI_API_KEY') || env('GOOGLE_AI_API_KEY') || env('GOOGLE_GENERATIVE_AI_API_KEY');
    default:
      return '';
  }
}

/**
 * Key for one provider.
 *
 * `AMOK_API_KEY` is deliberately scoped to the provider named by
 * `AMOK_PROVIDER`: a Groq key pasted into the generic slot must not make the
 * chain believe an OpenRouter fallback is usable.
 */
function keyFor(name: string): string {
  const explicit = (env('AMOK_PROVIDER') || '').toLowerCase();
  const generic = name === explicit ? env('AMOK_API_KEY') : '';
  return generic || vendorKey(name);
}

const DEFAULT_MODELS: Record<string, string> = {
  // gpt-4o-mini holds a character prompt well and costs almost nothing; swap to
  // `anthropic/claude-sonnet-4` on OpenRouter for a noticeably better Weasel.
  openrouter: 'openai/gpt-4o-mini',
  openai: 'gpt-4o-mini',
  // Haiku is the cheap side of Anthropic; still the best of the three at
  // staying inside a specific comedic voice.
  anthropic: 'claude-3-5-haiku-latest',
  groq: 'llama-3.3-70b-versatile',
  google: 'gemini-2.5-flash',
  vertex: 'gemini-2.5-flash',
};

function modelFor(name: string, override?: string): string {
  return (override ?? env('AMOK_MODEL') ?? '').trim() || DEFAULT_MODELS[name] || DEFAULT_MODELS.openai;
}

/** Providers with credentials, in the order they should be tried. */
export function amokProviderChain(): string[] {
  const primary = (env('AMOK_PROVIDER') || '').toLowerCase();
  // With no explicit choice, prefer a non-Google vendor: the usual reason to
  // be reading this file is that Google is the thing that broke.
  const fallbackDefault = vendorKey('openrouter') ? 'openrouter' : 'vertex,google';
  const chain: string[] = [];
  const push = (name: string) => {
    const n = name.trim().toLowerCase();
    if (!n || chain.includes(n)) return;
    // `vertex` has no API key of its own; its adapter only registers when ADC
    // credentials load, so presence in the map is the readiness check.
    if (n === 'vertex') {
      if (adapters.has('vertex')) chain.push(n);
      return;
    }
    if (keyFor(n)) chain.push(n);
  };
  push(primary || fallbackDefault);
  for (const name of (env('AMOK_FALLBACK') || fallbackDefault).split(',')) push(name);
  return chain;
}

function timeoutFor(opts: AmokChatOptions, fallback: number): number {
  const ms = opts.timeoutMs ?? Number(env('AMOK_TIMEOUT_MS') || 0);
  return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

/* ---------------------------------------------------------------- dialects */

interface OpenAiDialect {
  endpoint: string;
  /** Extra headers a vendor wants (OpenRouter attribution, for example). */
  headers?: Record<string, string>;
}

const OPENAI_DIALECTS: Record<string, OpenAiDialect> = {
  openrouter: {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    // OpenRouter uses these for its leaderboard only; harmless if ignored.
    headers: { 'HTTP-Referer': 'https://www.vaporzr.app', 'X-Title': 'Vaporzr' },
  },
  openai: { endpoint: 'https://api.openai.com/v1/chat/completions' },
  groq: { endpoint: 'https://api.groq.com/openai/v1/chat/completions' },
};

function makeOpenAiAdapter(name: string, dialect: OpenAiDialect): AmokAdapter {
  return {
    async chat(opts) {
      const res = await fetch(dialect.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyFor(name)}`,
          'Content-Type': 'application/json',
          ...dialect.headers,
        },
        body: JSON.stringify({
          model: modelFor(name, opts.model),
          messages: opts.messages,
          temperature: opts.temperature ?? 0.9,
          max_tokens: opts.maxTokens ?? 220,
        }),
        signal: AbortSignal.timeout(timeoutFor(opts, 25_000)),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${detail.slice(0, 180)}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content ?? '';
      if (!text.trim()) throw new Error('empty completion');
      return text.trim();
    },
  };
}

function makeAnthropicAdapter(): AmokAdapter {
  return {
    async chat(opts) {
      const system = opts.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const messages = opts.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));
      const body: Record<string, unknown> = {
        model: modelFor('anthropic', opts.model),
        max_tokens: opts.maxTokens ?? 220,
        temperature: opts.temperature ?? 0.9,
        messages,
      };
      // Anthropic takes the system prompt as a top-level field, not a message.
      if (system) body.system = system;
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': keyFor('anthropic'),
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutFor(opts, 25_000)),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${detail.slice(0, 180)}`);
      }
      const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
      const text = (data.content ?? [])
        .filter((c) => c.type === 'text' || c.text)
        .map((c) => c.text ?? '')
        .join('')
        .trim();
      if (!text) throw new Error('empty completion');
      return text;
    },
  };
}

function makeGoogleAdapter(): AmokAdapter {
  const base = 'https://generativelanguage.googleapis.com/v1beta/models';
  const key = () => keyFor('google');

  async function generate(model: string, body: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const res = await fetch(`${base}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  return {
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
          temperature: opts.temperature ?? 0.9,
          maxOutputTokens: opts.maxTokens ?? 220,
        },
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      const text = await generate(modelFor('google', opts.model), body, timeoutFor(opts, 25_000));
      if (!text) throw new Error('empty completion');
      return text;
    },

    async grounded(prompt, timeoutMs = 9_000) {
      try {
        // `googleSearch` is the Gemini API's web-grounding tool. If the model
        // or key does not allow it the call 400s and we report "no facts"
        // rather than retrying, because the caller treats null as "skip".
        const text = await generate(
          env('AMOK_GROUNDING_MODEL') || 'gemini-2.5-flash',
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
        const text = await generate(
          env('AMOK_STT_MODEL') || 'gemini-2.5-flash',
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
  };
}

/* ------------------------------------------------------- speech recognition */

interface WhisperDialect {
  endpoint: string;
  model: string;
}

const WHISPER_DIALECTS: Record<string, WhisperDialect> = {
  openai: { endpoint: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1' },
  groq: { endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3' },
};

function makeWhisperTranscriber(name: string, dialect: WhisperDialect): NonNullable<AmokAdapter['transcribe']> {
  return async (wav) => {
    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utterance.wav');
      form.append('model', env('AMOK_STT_MODEL') || dialect.model);
      const res = await fetch(dialect.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${keyFor(name)}` },
        body: form,
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { text?: string };
      const text = (data.text ?? '').trim();
      return text || null;
    } catch {
      return null;
    }
  };
}

/* --------------------------------------------------------------- bootstrap */

for (const name of ['openrouter', 'openai', 'groq']) {
  const adapter = makeOpenAiAdapter(name, OPENAI_DIALECTS[name]!);
  const whisper = WHISPER_DIALECTS[name];
  // Only OpenAI and Groq also do Whisper. OpenRouter has no audio endpoint, so
  // its adapter simply has no `transcribe` and the STT chain skips it.
  registerAmokAdapter(name, whisper ? { ...adapter, transcribe: makeWhisperTranscriber(name, whisper) } : adapter);
}
registerAmokAdapter('anthropic', makeAnthropicAdapter());
registerAmokAdapter('google', makeGoogleAdapter());

/* ------------------------------------------------------------------- calls */

/**
 * Walk the provider chain until one answers.
 *
 * Failures are logged with the provider and a truncated reason: a 401 and a
 * 429 both look like "Amok is broken" to a user, but they need different
 * fixes, and the log is the only place that distinction survives.
 */
export async function amokChat(opts: AmokChatOptions): Promise<string> {
  const chain = amokProviderChain();
  if (chain.length === 0) {
    throw new Error(
      'No AI provider is configured. Set AMOK_PROVIDER + AMOK_API_KEY (or OPENROUTER_API_KEY), or restore the Google credentials.',
    );
  }
  const errors: string[] = [];
  for (const name of chain) {
    const adapter = adapters.get(name);
    if (!adapter) continue;
    const started = Date.now();
    try {
      const text = await adapter.chat(opts);
      console.log(
        `[amok-provider] ${name}·${modelFor(name, opts.model)} ok ${Date.now() - started}ms (${opts.label ?? 'chat'})`,
      );
      return text;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push(`${name}: ${reason}`);
      console.warn(`[amok-provider] ${name} failed in ${Date.now() - started}ms: ${reason}`);
    }
  }
  throw new Error(`Every AI provider failed — ${errors.join(' | ')}`);
}

/** Web-grounded facts, or null when no configured provider can search. */
export async function amokGroundedFacts(prompt: string, timeoutMs = 9_000): Promise<string | null> {
  for (const name of amokProviderChain()) {
    const adapter = adapters.get(name);
    if (!adapter?.grounded) continue;
    const facts = await adapter.grounded(prompt, timeoutMs);
    if (facts) return facts;
  }
  return null;
}

/** Speech-to-text, or null when no configured provider can transcribe. */
export async function amokTranscribe(wav: Buffer): Promise<string | null> {
  for (const name of amokProviderChain()) {
    const adapter = adapters.get(name);
    if (!adapter?.transcribe) continue;
    const text = await adapter.transcribe(wav);
    if (text) return text;
  }
  return null;
}

/** True when at least one provider is ready; used to skip work that would only fail. */
export function amokConfigured(): boolean {
  return amokProviderChain().length > 0;
}
