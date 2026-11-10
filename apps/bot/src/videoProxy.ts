/**
 * `/api/video/<id>` — the bot's own video proxy.
 *
 * Why this exists: an embedded YouTube iframe fails for a large share of
 * official music videos (embedding disabled) and is blocked outright inside
 * the Discord Activity by its CSP. Downloading the picture through the bot —
 * via the same cookie/PO-token/proxy route chain that already plays the audio —
 * gives every surface the same, seekable file.
 *
 * Flow:
 *   GET /api/video/<id>          cached file (Range supported) or 202 + job start
 *   GET /api/video/<id>?check=1  { status: 'ready' | 'preparing' | 'failed' }
 *
 * Downloads are capped, pruned to the last few tracks, and limited to two at a
 * time so a visualizer left open cannot starve the music stream.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '@vaporzr/core/config';
import { downloadYoutubeVideo } from '@vaporzr/core/youtube';

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
/** Hard ceiling for one cached video (~40 min at 360p). */
const MAX_BYTES = 180 * 1024 * 1024;
/** How many videos to keep on disk. */
const KEEP_FILES = 12;
/** At most this many downloads may run at once (the VPS is also playing music). */
const MAX_CONCURRENT = 2;

type Job = 'preparing' | 'failed';
const jobs = new Map<string, Job>();

function cacheDir(): string {
  const dir = path.join(config.dataDir, 'video-cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function prune(dir: string): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const old of files.slice(KEEP_FILES)) {
      fs.rmSync(path.join(dir, old.f), { force: true });
    }
  } catch {
    /* pruning is housekeeping, never fatal */
  }
}

function serveFile(req: IncomingMessage, res: ServerResponse, file: string): void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  /** A read that fails after the headers are out must end the response, or the
   *  client waits forever on a body that will never arrive. */
  const pipe = (stream: fs.ReadStream): void => {
    stream.on('error', () => {
      try {
        res.end();
      } catch {
        /* client already gone */
      }
    });
    stream.pipe(res);
  };
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start <= end && start < size) {
        res.writeHead(206, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=86400',
        });
        pipe(fs.createReadStream(file, { start, end }));
        return;
      }
    }
  }
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': String(size),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
  });
  pipe(fs.createReadStream(file));
}

/** Mark a job failed AND let a later request retry it — a 'failed' entry that
 *  never expires makes that video permanently un-requestable until restart. */
function failJob(id: string): void {
  jobs.set(id, 'failed');
  setTimeout(() => jobs.delete(id), 5 * 60_000).unref?.();
}

function startJob(id: string, file: string): void {
  if (jobs.has(id)) return;
  const active = [...jobs.values()].filter((j) => j === 'preparing').length;
  if (active >= MAX_CONCURRENT) {
    // Not fatal: the page retries, and a slot usually frees within a minute.
    return;
  }
  jobs.set(id, 'preparing');
  const tmp = `${file}.part`;
  void downloadYoutubeVideo(id, tmp, 360)
    .then((ok) => {
      let size = 0;
      try {
        size = fs.statSync(tmp).size;
      } catch {
        /* no file */
      }
      if (!ok || size < 1024 || size > MAX_BYTES) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* best effort */
        }
        failJob(id);
        return;
      }
      try {
        fs.renameSync(tmp, file);
      } catch {
        failJob(id);
        return;
      }
      jobs.delete(id);
      prune(path.dirname(file));
      console.log(`[video] cached ${id} (${(size / (1024 * 1024)).toFixed(1)} MB)`);
    })
    .catch(() => {
      failJob(id);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
    });
}

export function handleVideoProxy(req: IncomingMessage, res: ServerResponse, rawId: string, url: URL): void {
  const id = String(rawId ?? '').replace(/\.mp4$/i, '');
  if (req.method !== 'GET' || !ID_RE.test(id)) {
    res.writeHead(req.method === 'GET' ? 400 : 405);
    res.end();
    return;
  }
  const file = path.join(cacheDir(), `${id}.mp4`);
  const ready = fs.existsSync(file);

  if (url.searchParams.get('check')) {
    // The page polls this endpoint, so it is also what starts the download —
    // otherwise nothing would ever kick the job off.
    if (!ready && !jobs.has(id)) startJob(id, file);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: ready ? 'ready' : (jobs.get(id) ?? 'preparing') }));
    return;
  }

  if (ready) {
    serveFile(req, res, file);
    return;
  }
  if (jobs.get(id) === 'failed') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'failed' }));
    return;
  }
  startJob(id, file);
  res.writeHead(202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ status: 'preparing' }));
}
