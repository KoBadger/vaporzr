import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  generateVAPIDKeys: vi.fn(() => ({ publicKey: 'test-pub', privateKey: 'test-priv' })),
}));

vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: () => mocks.generateVAPIDKeys(),
    setVapidDetails: () => {},
    sendNotification: (...args: unknown[]) => mocks.sendNotification(...args),
  },
}));

import { addPushSubscription, pushBroadcast, pushPublicKey, pushSubscriptionCount, removePushSubscription } from '../push.js';
import { config } from '../config.js';

describe('push store', () => {
  let tmp: string;
  const original = config.dataDir;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-push-'));
    config.dataDir = tmp;
  });

  afterAll(() => {
    config.dataDir = original;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } });

  it('generates a public key and de-dupes subscriptions', () => {
    expect(pushPublicKey()).toBe('test-pub');
    expect(pushSubscriptionCount()).toBe(0);
    addPushSubscription(sub('e1'));
    addPushSubscription(sub('e1'));
    expect(pushSubscriptionCount()).toBe(1);
    removePushSubscription('e1');
    expect(pushSubscriptionCount()).toBe(0);
  });

  it('broadcasts and prunes gone (410) subscriptions', async () => {
    addPushSubscription(sub('e2'));
    mocks.sendNotification.mockResolvedValueOnce(undefined);
    await pushBroadcast({ title: 'Vaporzr', body: 'hi' });
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);

    mocks.sendNotification.mockRejectedValueOnce({ statusCode: 410 });
    await pushBroadcast({ title: 'Vaporzr', body: 'hi' });
    expect(pushSubscriptionCount()).toBe(0);
  });

  it('does not throw when there are no subscriptions', async () => {
    await expect(pushBroadcast({ title: 't', body: 'b' })).resolves.toBeUndefined();
  });
});
