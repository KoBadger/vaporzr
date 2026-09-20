import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { config } from './config.js';

interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const vapidFile = (): string => path.join(config.dataDir, 'push-vapid.json');
const subsFile = (): string => path.join(config.dataDir, 'push-subs.json');

let vapid: { publicKey: string; privateKey: string } | null = null;

function loadVapid(): { publicKey: string; privateKey: string } {
  if (vapid) return vapid;
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    vapid = { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey };
    return vapid;
  }
  try {
    const saved = JSON.parse(fs.readFileSync(vapidFile(), 'utf8')) as { publicKey: string; privateKey: string };
    if (saved.publicKey && saved.privateKey) {
      vapid = saved;
      return vapid;
    }
  } catch {
    /* generate below */
  }
  const gen = webpush.generateVAPIDKeys();
  vapid = { publicKey: gen.publicKey, privateKey: gen.privateKey };
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(vapidFile(), JSON.stringify(vapid, null, 2), 'utf8');
  } catch (err) {
    console.warn('[push] could not persist VAPID keys:', err instanceof Error ? err.message : err);
  }
  return vapid;
}

let subs: PushSub[] | null = null;

function loadSubs(): PushSub[] {
  if (subs) return subs;
  try {
    const parsed = JSON.parse(fs.readFileSync(subsFile(), 'utf8')) as PushSub[];
    subs = Array.isArray(parsed) ? parsed : [];
  } catch {
    subs = [];
  }
  return subs;
}

function saveSubs(): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(subsFile(), JSON.stringify(subs ?? [], null, 2), 'utf8');
  } catch (err) {
    console.warn('[push] could not persist subscriptions:', err instanceof Error ? err.message : err);
  }
}

/** The VAPID public key the browser needs to subscribe. */
export function pushPublicKey(): string {
  return loadVapid().publicKey;
}

export function addPushSubscription(sub: PushSub): void {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return;
  const list = loadSubs();
  if (!list.some((s) => s.endpoint === sub.endpoint)) {
    list.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
    saveSubs();
  }
}

export function removePushSubscription(endpoint: string): void {
  const list = loadSubs();
  const idx = list.findIndex((s) => s.endpoint === endpoint);
  if (idx >= 0) {
    list.splice(idx, 1);
    saveSubs();
  }
}

export function pushSubscriptionCount(): number {
  return loadSubs().length;
}

/** Send a notification to every subscribed browser (expired subs are pruned). */
export async function pushBroadcast(payload: { title: string; body: string; url?: string }): Promise<void> {
  const list = loadSubs();
  if (list.length === 0) return;
  const keys = loadVapid();
  try {
    webpush.setVapidDetails(config.pushContact, keys.publicKey, keys.privateKey);
  } catch (err) {
    console.warn('[push] invalid VAPID config:', err instanceof Error ? err.message : err);
    return;
  }
  const body = JSON.stringify(payload);
  await Promise.all(
    list.map(async (s) => {
      try {
        await webpush.sendNotification(s as webpush.PushSubscription, body);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) removePushSubscription(s.endpoint);
        else console.warn('[push] send failed:', err instanceof Error ? err.message : err);
      }
    }),
  );
}
