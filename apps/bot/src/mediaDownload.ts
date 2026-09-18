import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Download an http(s) media stream to a temp file using Node's fetch (Range
 * chunks + a browser User-Agent). ffmpeg's own HTTPS client is rejected with 403
 * on googlevideo URLs (TLS fingerprint), which is why the main playback path
 * pipes bytes through Node — this does the same for `/mix`, where ffmpeg needs
 * the media as a seekable input. Returns the temp path (caller deletes it) or
 * null on failure.
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export async function downloadToTempFile(url: string, maxBytes = 80 * 1024 * 1024): Promise<string | null> {
  const file = path.join(os.tmpdir(), `vaporzr-mix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  let handle: Awaited<ReturnType<typeof fs.promises.open>> | null = null;
  try {
    handle = await fs.promises.open(file, 'w');
    let offset = 0;
    const CHUNK = 512 * 1024;
    for (;;) {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Range: `bytes=${offset}-${offset + CHUNK - 1}` },
      });
      if (res.status === 416) break; // past EOF
      if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const chunk = Buffer.from(await res.arrayBuffer());
      if (!chunk.length) break;
      await handle.write(chunk);
      offset += chunk.length;
      if (offset >= maxBytes) break;
      if (chunk.length < CHUNK) break;
    }
    await handle.close();
    handle = null;
    if (offset === 0) {
      fs.rmSync(file, { force: true });
      return null;
    }
    return file;
  } catch {
    try {
      await handle?.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(file, { force: true });
    return null;
  }
}
