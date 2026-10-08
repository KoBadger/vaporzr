import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '@vaporzr/core/config';

/**
 * Hosted stem separation via Replicate's Demucs (GPU).
 *
 * The bot's default is a local CPU Demucs run: free and private, but ~29 min
 * for a two-track mashup. Replicate runs the SAME htdemucs model on a T4 for
 * roughly 2¢ and ~80s, which is the whole point of this module. It is strictly
 * opt-in: with no `REPLICATE_API_TOKEN` every entry point returns null and the
 * caller falls back to local Demucs.
 */

const API = 'https://api.replicate.com/v1';

/** True when a Replicate token is configured (hosted stems available). */
export function replicateStemsEnabled(): boolean {
  return !!config.replicateApiToken;
}

interface ReplicateFile {
  id?: string;
  urls?: { get?: string };
}

type PredictionStatus = 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
interface ReplicatePrediction {
  id: string;
  status: PredictionStatus;
  output?: Record<string, string | null> | null;
  error?: unknown;
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${config.replicateApiToken}` };
}

function short(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

/** Upload a local file to Replicate and return its fetchable URL. */
async function uploadFile(file: string): Promise<string> {
  const bytes = await fs.readFile(file);
  const form = new FormData();
  form.append('content', new Blob([bytes], { type: 'audio/mpeg' }), path.basename(file) || 'audio.mp3');
  const res = await fetch(`${API}/files`, { method: 'POST', headers: auth(), body: form });
  if (!res.ok) throw new Error(`file upload ${res.status}: ${short(await res.text().catch(() => ''))}`);
  const json = (await res.json()) as ReplicateFile;
  const url = json.urls?.get;
  if (!url) throw new Error('file upload returned no URL');
  return url;
}

/** Kick off a Demucs prediction for an uploaded file. */
async function createPrediction(audioUrl: string): Promise<ReplicatePrediction> {
  const [owner, name] = config.replicateDemucsModel.split('/');
  if (!owner || !name) throw new Error(`bad REPLICATE_DEMUCS_MODEL "${config.replicateDemucsModel}"`);
  const res = await fetch(`${API}/models/${owner}/${name}/predictions`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    // `stem: 'vocals'` asks the 2-stem path (vocals + the rest), which is all a
    // mashup needs and is faster/cheaper than the full 4-stem split.
    body: JSON.stringify({
      input: { audio: audioUrl, model_name: 'htdemucs', output_format: 'mp3', mp3_bitrate: 320, stem: 'vocals' },
    }),
  });
  if (!res.ok) throw new Error(`prediction create ${res.status}: ${short(await res.text().catch(() => ''))}`);
  return (await res.json()) as ReplicatePrediction;
}

/** Poll a prediction until it finishes (or the timeout elapses). */
async function waitForPrediction(pred: ReplicatePrediction, timeoutMs: number): Promise<ReplicatePrediction> {
  const started = Date.now();
  let cur = pred;
  while (cur.status === 'starting' || cur.status === 'processing') {
    if (Date.now() - started > timeoutMs) throw new Error('prediction timed out');
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${API}/predictions/${cur.id}`, { headers: auth() });
    if (!res.ok) throw new Error(`prediction poll ${res.status}`);
    cur = (await res.json()) as ReplicatePrediction;
  }
  if (cur.status !== 'succeeded') {
    const detail = typeof cur.error === 'string' ? cur.error : JSON.stringify(cur.error ?? '');
    throw new Error(`prediction ${cur.status}: ${short(detail)}`);
  }
  return cur;
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`stem download ${res.status}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/** Sum several mp3 stems into one file (Demucs stems reconstruct the mix). */
async function mixStems(parts: string[], out: string): Promise<void> {
  const args = ['-hide_banner', '-loglevel', 'error'];
  for (const p of parts) args.push('-i', p);
  args.push('-filter_complex', `amix=inputs=${parts.length}:duration=longest:normalize=0`, '-c:a', 'libmp3lame', '-b:a', '192k', '-y', out);
  await new Promise<void>((resolve, reject) => {
    const p = spawn(config.ffmpegPath, args, { windowsHide: true });
    let err = '';
    p.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(short(err) || `ffmpeg exited ${code}`))));
  });
}

export interface ReplicateStems {
  vocals: string;
  other: string;
}

/**
 * Separate a local audio file into vocals + instrumental with hosted Demucs.
 * Returns the two stem paths, or null when unconfigured or on any failure (so
 * the caller can quietly fall back to the local CPU run).
 */
export async function separateStemsReplicate(
  file: string,
  outDir: string,
  timeoutMs = 10 * 60 * 1000,
): Promise<ReplicateStems | null> {
  if (!replicateStemsEnabled()) return null;
  try {
    await fs.mkdir(outDir, { recursive: true });
    const url = await uploadFile(file);
    const pred = await waitForPrediction(await createPrediction(url), timeoutMs);
    const out = pred.output;
    if (!out || typeof out !== 'object') throw new Error('returned no stems');

    const vocalsUrl = out.vocals ?? null;
    if (!vocalsUrl) throw new Error('returned no vocals stem');
    const vocals = path.join(outDir, 'vocals.mp3');
    await download(vocalsUrl, vocals);

    // The instrumental is "everything but vocals". A 2-stem prediction may hand
    // it back directly; otherwise rebuild it from the remaining stems.
    const other = path.join(outDir, 'no_vocals.mp3');
    const direct = out.no_vocals ?? out.instrumental ?? null;
    if (direct) {
      await download(direct, other);
    } else {
      const urls = [out.drums, out.bass, out.other].filter((u): u is string => !!u);
      if (urls.length === 0) throw new Error('returned no instrumental stem');
      if (urls.length === 1) {
        await download(urls[0], other);
      } else {
        const locals: string[] = [];
        for (let i = 0; i < urls.length; i++) {
          const lp = path.join(outDir, `stem-part-${i}.mp3`);
          await download(urls[i], lp);
          locals.push(lp);
        }
        try {
          await mixStems(locals, other);
        } finally {
          for (const lp of locals) await fs.rm(lp, { force: true }).catch(() => {});
        }
      }
    }
    return { vocals, other };
  } catch (e) {
    console.warn(`[stems] Replicate separation failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
