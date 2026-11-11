import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config } from '@vaporzr/core/config';
import {
  activePlan,
  applyBillingEvent,
  deckLimitFor,
  entitlementFor,
  grantEntitlement,
  mapStripeEvent,
  revokeEntitlement,
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
