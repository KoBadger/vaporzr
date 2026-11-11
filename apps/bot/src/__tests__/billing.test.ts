import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config } from '@vaporzr/core/config';
import {
  activePlan,
  applyBillingEvent,
  clearDeckSeat,
  createPortalSession,
  deckLimitFor,
  deckSeatFor,
  entitlementFor,
  featureAllowed,
  grantEntitlement,
  mapStripeEvent,
  revokeEntitlement,
  setDeckSeat,
  verifyStripeSignature,
} from '../billing.js';

const SECRET = 'whsec_test_secret';

function sigHeader(body: string, ts = Math.floor(Date.now() / 1000), secret = SECRET): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${v1}`;
}

describe('verifyStripeSignature', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });

  it('accepts a correctly signed body', () => {
    expect(verifyStripeSignature(body, sigHeader(body), SECRET)).toBe(true);
  });

  it('rejects a body that changed after signing', () => {
    expect(verifyStripeSignature(`${body} `, sigHeader(body), SECRET)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(verifyStripeSignature(body, sigHeader(body, undefined, 'whsec_other'), SECRET)).toBe(false);
  });

  it('rejects a stale timestamp (replay)', () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(verifyStripeSignature(body, sigHeader(body, old), SECRET)).toBe(false);
  });

  it('accepts when one of several v1 signatures matches', () => {
    const header = `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)},${sigHeader(body).split(',').slice(1).join(',')}`;
    // The bogus first signature is ignored; the valid one is accepted.
    expect(verifyStripeSignature(body, header, SECRET)).toBe(true);
  });

  it('rejects malformed or missing headers without throwing', () => {
    expect(verifyStripeSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyStripeSignature(body, '', SECRET)).toBe(false);
    expect(verifyStripeSignature(body, 'garbage', SECRET)).toBe(false);
    expect(verifyStripeSignature('', sigHeader(body), SECRET)).toBe(false);
    expect(verifyStripeSignature(body, sigHeader(body), '')).toBe(false);
  });
});

describe('mapStripeEvent', () => {
  const meta = { plan: 'server', subject: 'guild:123' };

  it('grants on a paid checkout', () => {
    expect(
      mapStripeEvent({
        type: 'checkout.session.completed',
        data: {
          object: { metadata: meta, payment_status: 'paid', customer: 'cus_1', subscription: 'sub_1' },
        },
      }),
    ).toEqual({
      kind: 'grant',
      subject: 'guild:123',
      plan: 'server',
      status: 'active',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
    });
  });

  it('ignores a checkout that has not settled', () => {
    expect(
      mapStripeEvent({
        type: 'checkout.session.completed',
        data: { object: { metadata: meta, payment_status: 'unpaid' } },
      }).kind,
    ).toBe('ignore');
  });

  it('grants a renewing subscription with its period end', () => {
    const action = mapStripeEvent({
      type: 'customer.subscription.updated',
      data: { object: { metadata: meta, status: 'active', current_period_end: 1900000000, customer: 'cus_1' } },
    });
    expect(action.kind).toBe('grant');
    expect(action.currentPeriodEnd).toBe(1900000000 * 1000);
  });

  it('revokes on cancellation and deletion', () => {
    expect(
      mapStripeEvent({
        type: 'customer.subscription.updated',
        data: { object: { metadata: meta, status: 'canceled' } },
      }).kind,
    ).toBe('revoke');
    expect(mapStripeEvent({ type: 'customer.subscription.deleted', data: { object: { metadata: meta } } }).kind).toBe(
      'revoke',
    );
  });

  it('ignores events without a plan or subject', () => {
    expect(mapStripeEvent({ type: 'customer.subscription.updated', data: { object: {} } }).kind).toBe('ignore');
    expect(mapStripeEvent({ type: 'invoice.paid', data: { object: {} } }).kind).toBe('ignore');
    expect(mapStripeEvent(null).kind).toBe('ignore');
  });
});

describe('entitlement store', () => {
  const original = config.dataDir;
  let tmp = '';

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-billing-'));
    config.dataDir = tmp;
  });

  afterAll(() => {
    config.dataDir = original;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('applies a grant and reports the plan', () => {
    applyBillingEvent({ kind: 'grant', subject: 'guild:1', plan: 'server', status: 'active' });
    expect(activePlan('guild:1')).toBe('server');
    expect(entitlementFor('guild:1')?.status).toBe('active');
  });

  it('keeps the plan through the past_due grace window, then lapses', () => {
    const now = Date.now();
    grantEntitlement('user:2', { plan: 'plus', status: 'past_due', currentPeriodEnd: now + 1000 });
    expect(activePlan('user:2', now)).toBe('plus');
    expect(activePlan('user:2', now + 1000 + 4 * 24 * 60 * 60 * 1000)).toBeNull();
  });

  it('drops the plan as soon as a cancelled subscription is past its paid period', () => {
    const now = Date.now();
    grantEntitlement('user:3', { plan: 'plus', status: 'active', currentPeriodEnd: now - 1 });
    expect(activePlan('user:3', now)).toBeNull();
  });

  it('revokes', () => {
    applyBillingEvent({ kind: 'revoke', subject: 'guild:1' });
    expect(activePlan('guild:1')).toBeNull();
    revokeEntitlement('guild:1'); // idempotent
  });
});

describe('deckLimitFor', () => {
  const original = {
    key: config.stripeSecretKey,
    plus: config.stripePricePlus,
    server: config.stripePriceServer,
    owner: config.ownerId,
  };

  afterAll(() => {
    config.stripeSecretKey = original.key;
    config.stripePricePlus = original.plus;
    config.stripePriceServer = original.server;
    config.ownerId = original.owner;
  });

  it('leaves all four decks available while billing is disabled', () => {
    // Enforcement must not take decks away from a deployment that never sold them.
    config.stripeSecretKey = '';
    expect(deckLimitFor('free')).toBe(4);
  });

  it('limits a free guild to two decks once billing is on', () => {
    config.stripeSecretKey = 'sk_test';
    config.stripePricePlus = 'price_plus';
    config.ownerId = '';
    expect(deckLimitFor('free')).toBe(2);
  });

  it('gives a Server guild all four decks', () => {
    grantEntitlement('guild:paid', { plan: 'server', status: 'active' });
    expect(deckLimitFor('paid')).toBe(4);
  });

  it("gives the owner's account four decks with Plus", () => {
    config.ownerId = 'owner-1';
    grantEntitlement('user:owner-1', { plan: 'plus', status: 'active' });
    expect(deckLimitFor('somebody-else')).toBe(4);
  });
});

describe('featureAllowed', () => {
  const original = {
    key: config.stripeSecretKey,
    plus: config.stripePricePlus,
    owner: config.ownerId,
  };

  afterAll(() => {
    config.stripeSecretKey = original.key;
    config.stripePricePlus = original.plus;
    config.ownerId = original.owner;
  });

  it('leaves every paid feature on while billing is disabled', () => {
    config.stripeSecretKey = '';
    expect(featureAllowed('nobody', 'recording')).toBe(true);
  });

  it('refuses a free guild once billing is on', () => {
    config.stripeSecretKey = 'sk_test';
    config.stripePricePlus = 'price_plus';
    config.ownerId = '';
    expect(featureAllowed('free-2', 'recording')).toBe(false);
  });

  it('allows a Server guild', () => {
    grantEntitlement('guild:server-2', { plan: 'server', status: 'active' });
    expect(featureAllowed('server-2', 'recording')).toBe(true);
  });

  it("allows the owner's Plus account", () => {
    config.ownerId = 'owner-2';
    grantEntitlement('user:owner-2', { plan: 'plus', status: 'active' });
    expect(featureAllowed('another-guild', 'themes')).toBe(true);
  });

  it('does not refuse an unknown feature', () => {
    // A typo or a future feature must not silently block work that used to run.
    expect(featureAllowed('free-2', 'nonsense' as never)).toBe(true);
  });
});

describe('deck seats', () => {
  const original = { key: config.stripeSecretKey, plus: config.stripePricePlus, owner: config.ownerId };

  afterAll(() => {
    config.stripeSecretKey = original.key;
    config.stripePricePlus = original.plus;
    config.ownerId = original.owner;
  });

  it('does nothing while billing is off', () => {
    config.stripeSecretKey = '';
    config.ownerId = '';
    setDeckSeat('seat-guild-off', 'nobody');
    expect(deckLimitFor('seat-guild-off')).toBe(4);
    clearDeckSeat('seat-guild-off');
  });

  it('ignores a seat held by an account without Plus', () => {
    config.stripeSecretKey = 'sk_test';
    config.stripePricePlus = 'price_plus';
    config.ownerId = '';
    setDeckSeat('seat-guild-free', 'free-user');
    expect(deckSeatFor('seat-guild-free')).toBe('free-user');
    expect(deckLimitFor('seat-guild-free')).toBe(2);
  });

  it('unlocks the second bank for a seated Plus account', () => {
    grantEntitlement('user:seat-plus', { plan: 'plus', status: 'active' });
    setDeckSeat('seat-guild-plus', 'seat-plus');
    expect(deckLimitFor('seat-guild-plus')).toBe(4);
  });

  it('frees the seat without cleanup when the subscription lapses', () => {
    // A cancelled plan keeps working until its paid period ends, then stops.
    grantEntitlement('user:seat-lapsed', { plan: 'plus', status: 'canceled', currentPeriodEnd: Date.now() - 1 });
    setDeckSeat('seat-guild-lapsed', 'seat-lapsed');
    // The seat record is still there; it just stops counting.
    expect(deckSeatFor('seat-guild-lapsed')).toBe('seat-lapsed');
    expect(deckLimitFor('seat-guild-lapsed')).toBe(2);
  });

  it('replaces and clears a seat', () => {
    grantEntitlement('user:seat-a', { plan: 'plus', status: 'active' });
    grantEntitlement('user:seat-b', { plan: 'plus', status: 'active' });
    setDeckSeat('seat-guild-swap', 'seat-a');
    setDeckSeat('seat-guild-swap', 'seat-b');
    expect(deckSeatFor('seat-guild-swap')).toBe('seat-b');
    clearDeckSeat('seat-guild-swap');
    expect(deckSeatFor('seat-guild-swap')).toBeNull();
    expect(deckLimitFor('seat-guild-swap')).toBe(2);
  });
});

describe('createPortalSession', () => {
  const original = {
    key: config.stripeSecretKey,
    plus: config.stripePricePlus,
    dataDir: config.dataDir,
    fetch: globalThis.fetch,
  };
  let tmp = '';

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-portal-'));
    config.dataDir = tmp;
    config.stripeSecretKey = 'sk_test';
    config.stripePricePlus = 'price_plus';
  });

  afterAll(() => {
    config.stripeSecretKey = original.key;
    config.stripePricePlus = original.plus;
    config.dataDir = original.dataDir;
    globalThis.fetch = original.fetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('opens the portal against the customer Stripe already knows', async () => {
    grantEntitlement('guild:portal', { plan: 'server', status: 'active', customerId: 'cus_123' });
    let seenUrl = '';
    let seenBody = '';
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenBody = String(init.body);
      return new Response(JSON.stringify({ url: 'https://billing.stripe.com/p/session_abc' }), { status: 200 });
    }) as unknown as typeof fetch;

    const session = await createPortalSession({ subject: 'guild:portal', origin: 'https://www.vaporzr.app/' });

    expect(session.url).toBe('https://billing.stripe.com/p/session_abc');
    expect(seenUrl).toBe('https://api.stripe.com/v1/billing_portal/sessions');
    const form = new URLSearchParams(seenBody);
    expect(form.get('customer')).toBe('cus_123');
    // The trailing slash on the origin must not become a double slash.
    expect(form.get('return_url')).toBe('https://www.vaporzr.app/panel?billing=portal');
  });

  it('refuses a subject that has never paid, without calling Stripe', async () => {
    grantEntitlement('guild:never-paid', { plan: 'server', status: 'active' });
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await expect(createPortalSession({ subject: 'guild:never-paid', origin: 'https://x' })).rejects.toThrow(
      /No subscription/,
    );
    expect(called).toBe(false);
  });

  it('surfaces the Stripe message when the portal call fails', async () => {
    grantEntitlement('guild:broken', { plan: 'server', status: 'active', customerId: 'cus_9' });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'No such customer' } }), {
        status: 400,
      })) as unknown as typeof fetch;

    await expect(createPortalSession({ subject: 'guild:broken', origin: 'https://x' })).rejects.toThrow(
      /No such customer/,
    );
  });
});
