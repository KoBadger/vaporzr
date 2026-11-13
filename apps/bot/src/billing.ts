import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
import { writeJsonAtomicSync } from './jsonFile.js';

/**
 * Stripe billing for the two tiers the portal advertises:
 *
 *   plus   — per Discord account (4 decks, recording/export, themes, lossless)
 *   server — per Discord guild (5 servers, white-label, analytics/API)
 *
 * Everything here is inert until `STRIPE_SECRET_KEY` and at least one
 * `STRIPE_PRICE_*` are set, so a deployment without billing behaves exactly as
 * before. There is no Stripe SDK dependency: checkout is one form-encoded POST
 * and webhooks are an HMAC check over the raw body.
 */

export type BillingPlan = 'plus' | 'server';
export type BillingStatus = 'active' | 'trialing' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete';

/** Billing subject: `user:<discord id>` or `guild:<discord id>`. */
export type BillingSubject = string;

export interface Entitlement {
  plan: BillingPlan;
  status: BillingStatus;
  customerId?: string;
  subscriptionId?: string;
  /** ms epoch at which the paid period ends (Stripe `current_period_end`). */
  currentPeriodEnd?: number;
  /** ms epoch when this record last changed. */
  updatedAt: number;
}

/** A failed payment keeps the plan for this long before it lapses. */
const GRACE_MS = 3 * 24 * 60 * 60 * 1000;
/** Reject a webhook whose timestamp is older/newer than this (replay window). */
const SIGNATURE_TOLERANCE_SEC = 300;

export function billingEnabled(): boolean {
  return Boolean(
    config.stripeSecretKey &&
    (config.stripePricePlus || config.stripePriceServer || config.stripePricePlusYear || config.stripePriceServerYear),
  );
}

/** Which billing cadence a checkout is for. Entitlements ignore it. */
export type BillingInterval = 'month' | 'year';

export function priceIdFor(plan: BillingPlan, interval: BillingInterval = 'month'): string {
  if (interval === 'year') {
    return plan === 'plus' ? config.stripePricePlusYear : config.stripePriceServerYear;
  }
  return plan === 'plus' ? config.stripePricePlus : config.stripePriceServer;
}

/** Whether a yearly price exists for this plan, so the UI can offer it. */
export function annualAvailable(plan: BillingPlan): boolean {
  return Boolean(priceIdFor(plan, 'year'));
}

function storeFile(): string {
  return path.join(config.dataDir, 'entitlements.json');
}

let cache: Record<string, Entitlement> | null = null;

function load(): Record<string, Entitlement> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as unknown;
    cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, Entitlement>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save(): void {
  try {
    writeJsonAtomicSync(storeFile(), cache ?? {});
  } catch (err) {
    console.warn('[billing] could not persist entitlements:', err instanceof Error ? err.message : err);
  }
}

/** Raw record for a subject, expired or not. */
export function entitlementFor(subject: BillingSubject): Entitlement | null {
  const entry = load()[subject];
  return entry ?? null;
}

/**
 * The plan a subject is entitled to right now. `past_due` keeps the plan through
 * the grace window (a card retry shouldn't cut someone off mid-session); a
 * cancelled subscription lapses when its paid period ends.
 */
export function activePlan(subject: BillingSubject, now = Date.now()): BillingPlan | null {
  const entry = load()[subject];
  if (!entry) return null;
  if (entry.status === 'canceled' || entry.status === 'unpaid' || entry.status === 'incomplete') return null;
  if (entry.currentPeriodEnd && now > entry.currentPeriodEnd + (entry.status === 'past_due' ? GRACE_MS : 0)) {
    return null;
  }
  return entry.plan;
}

export function grantEntitlement(subject: BillingSubject, entry: Omit<Entitlement, 'updatedAt'>): Entitlement {
  const record: Entitlement = { ...entry, updatedAt: Date.now() };
  load()[subject] = record;
  save();
  return record;
}

export function revokeEntitlement(subject: BillingSubject): void {
  const store = load();
  if (!(subject in store)) return;
  delete store[subject];
  save();
}

/* ------------------------------------------------------------------ */
/* Deck seats                                                          */
/* ------------------------------------------------------------------ */

/**
 * A Plus subscriber may bind their account to one server's decks.
 *
 * Plus is bought per account while decks are enforced per guild, and the panel
 * has no Discord identity to match the two up — so the binding is made in
 * Discord, where the user id is known, and stored here. The seat is only worth
 * anything while that account's Plus is active: every read re-checks
 * `activePlan`, so a lapsed subscription frees the seat with no cleanup job.
 */
interface DeckSeat {
  userId: string;
  at: number;
}

function seatsFile(): string {
  return path.join(config.dataDir, 'deck-seats.json');
}

let seatCache: Record<string, DeckSeat> | null = null;

function loadSeats(): Record<string, DeckSeat> {
  if (seatCache) return seatCache;
  try {
    const raw = JSON.parse(fs.readFileSync(seatsFile(), 'utf8')) as unknown;
    seatCache = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, DeckSeat>) : {};
  } catch {
    seatCache = {};
  }
  return seatCache;
}

function saveSeats(): void {
  try {
    writeJsonAtomicSync(seatsFile(), seatCache ?? {});
  } catch (err) {
    console.warn('[billing] could not persist deck seats:', err instanceof Error ? err.message : err);
  }
}

/** The account currently holding this guild's seat, if any. */
export function deckSeatFor(guildId: string): string | null {
  return loadSeats()[guildId]?.userId ?? null;
}

/** Bind a guild's decks to one account. One seat per guild; it replaces any other. */
export function setDeckSeat(guildId: string, userId: string): void {
  if (!guildId || !userId) return;
  loadSeats()[guildId] = { userId, at: Date.now() };
  saveSeats();
}

export function clearDeckSeat(guildId: string): void {
  const store = loadSeats();
  if (!(guildId in store)) return;
  delete store[guildId];
  saveSeats();
}

/** All subjects with a currently active plan (for /api/billing/status "all"). */
export function activeSubjects(now = Date.now()): { subject: string; plan: BillingPlan }[] {
  const out: { subject: string; plan: BillingPlan }[] = [];
  for (const subject of Object.keys(load())) {
    const plan = activePlan(subject, now);
    if (plan) out.push({ subject, plan });
  }
  return out;
}

/**
 * How many live decks a guild may use.
 *
 * Free covers A/B; Server covers all four, and so does the owner's Plus (the
 * panel is the owner's surface — a per-user plan has no seat of its own there).
 * With billing disabled every deck stays available: the paywall only means
 * something once it can actually be bought, and switching it on by default would
 * take four decks away from a deployment that never sold them.
 */
export function deckLimitFor(guildId: string, ownerId = config.ownerId): 2 | 4 {
  if (!billingEnabled()) return 4;
  if (activePlan(`guild:${guildId}`) === 'server') return 4;
  if (ownerId && activePlan(`user:${ownerId}`) === 'plus') return 4;
  // A seated Plus account unlocks this guild's second bank. Re-checked on every
  // read, so the seat lapses with the subscription.
  const seat = deckSeatFor(guildId);
  if (seat && activePlan(`user:${seat}`) === 'plus') return 4;
  return 2;
}

/** Paid capabilities that are not deck-count, and which plan unlocks each. */
export type PaidFeature = 'recording' | 'themes' | 'lossless' | 'analytics' | 'whitelabel' | 'amokVoice';

const FEATURE_PLANS: Record<PaidFeature, BillingPlan[]> = {
  recording: ['plus', 'server'],
  themes: ['plus', 'server'],
  lossless: ['plus', 'server'],
  // Spoken replies cost money per second of generated audio, so this is the one
  // gate that is aligned with the actual bill rather than with a feature list.
  // Text chat stays free.
  amokVoice: ['plus', 'server'],
  // Analytics and the custom-domain white-label are Server-plan dashboard
  // features only; a per-account Plus seat does not unlock them.
  analytics: ['server'],
  whitelabel: ['server'],
};

/**
 * Whether a guild may use a paid feature.
 *
 * Server covers everything. Plus is bought per account, but the surfaces that
 * expose these features are the owner's (panel, /deck), so Plus is honoured for
 * the owner's account — the same rule `deckLimitFor` uses. With billing
 * disabled nothing is gated: a deployment that never sold a plan keeps every
 * feature.
 */
export function featureAllowed(guildId: string, feature: PaidFeature, ownerId = config.ownerId): boolean {
  if (!billingEnabled()) return true;
  const plans = FEATURE_PLANS[feature];
  // An unknown feature must not start refusing work it used to do.
  if (!plans || plans.length === 0) return true;
  if (plans.includes('server') && activePlan(`guild:${guildId}`) === 'server') return true;
  if (plans.includes('plus') && ownerId && activePlan(`user:${ownerId}`) === 'plus') return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Checkout                                                            */
/* ------------------------------------------------------------------ */

export interface CheckoutRequest {
  plan: BillingPlan;
  subject: BillingSubject;
  /** Public origin for the success/cancel redirects, e.g. https://www.vaporzr.app */
  origin: string;
  email?: string;
  /** Defaults to monthly. Entitlements are the same either way. */
  interval?: BillingInterval;
}

/**
 * Create a Stripe Checkout session and return its hosted URL.
 *
 * The subject rides along in `client_reference_id` and in both the session and
 * subscription metadata, so the webhook can grant the entitlement without a
 * lookup table of its own.
 */
export async function createCheckoutSession(req: CheckoutRequest): Promise<{ url: string; id: string }> {
  if (!billingEnabled()) throw new Error('Billing is not configured.');
  const interval: BillingInterval = req.interval === 'year' ? 'year' : 'month';
  const price = priceIdFor(req.plan, interval);
  if (!price) {
    throw new Error(
      interval === 'year'
        ? `No annual Stripe price is configured for the ${req.plan} plan.`
        : `No Stripe price configured for the ${req.plan} plan.`,
    );
  }
  const base = req.origin.replace(/\/+$/, '');

  const form = new URLSearchParams();
  form.set('mode', 'subscription');
  form.set('line_items[0][price]', price);
  form.set('line_items[0][quantity]', '1');
  form.set('success_url', `${base}/panel?billing=success`);
  form.set('cancel_url', `${base}/?billing=cancel`);
  form.set('client_reference_id', req.subject);
  form.set('allow_promotion_codes', 'true');
  // A trial converts roughly twice as often as a bare price, and Stripe already
  // reports `trialing` in the webhook, which `activePlan` treats as entitled.
  const trialDays = Number.isFinite(config.stripeTrialDays) ? Math.max(0, Math.floor(config.stripeTrialDays)) : 7;
  if (trialDays > 0 && interval === 'month') {
    // Only on monthly: a trial on an annual plan just delays the first big charge.
    form.set('subscription_data[trial_period_days]', String(trialDays));
  }
  form.set('metadata[plan]', req.plan);
  form.set('metadata[interval]', interval);
  form.set('metadata[subject]', req.subject);
  form.set('subscription_data[metadata][plan]', req.plan);
  form.set('subscription_data[metadata][interval]', interval);
  form.set('subscription_data[metadata][subject]', req.subject);
  if (req.email) form.set('customer_email', req.email);

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // A retried click must not create a second subscription.
      'Idempotency-Key': `checkout:${req.subject}:${req.plan}:${Math.floor(Date.now() / 60_000)}`,
    },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; id?: string; error?: { message?: string } };
  if (!res.ok || !body.url || !body.id) {
    throw new Error(body.error?.message ?? `Stripe checkout failed (HTTP ${res.status}).`);
  }
  return { id: body.id, url: body.url };
}

export interface PortalRequest {
  subject: BillingSubject;
  /** Where Stripe sends the customer back to, e.g. https://www.vaporzr.app */
  origin: string;
}

/**
 * Create a Stripe billing-portal session so a customer can swap a card or
 * cancel without emailing the owner.
 *
 * The portal is keyed on the Stripe customer, which only exists once a
 * subscription does — a subject with no `customerId` has never paid, so there
 * is nothing to manage and we say so rather than opening an empty portal.
 */
export async function createPortalSession(req: PortalRequest): Promise<{ url: string }> {
  if (!billingEnabled()) throw new Error('Billing is not configured.');
  const entry = entitlementFor(req.subject);
  if (!entry?.customerId) throw new Error('No subscription to manage.');
  const base = req.origin.replace(/\/+$/, '');

  const form = new URLSearchParams();
  form.set('customer', entry.customerId);
  form.set('return_url', `${base}/panel?billing=portal`);

  const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: { message?: string } };
  if (!res.ok || !body.url) {
    throw new Error(body.error?.message ?? `Stripe portal failed (HTTP ${res.status}).`);
  }
  return { url: body.url };
}

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

/**
 * Verify a `Stripe-Signature` header against the raw request body.
 *
 * Format: `t=<unix seconds>,v1=<hex hmac>[,v1=…]`. The signed payload is
 * `${t}.${rawBody}`. Timing-safe, with a replay window. Returns false for any
 * malformed header rather than throwing.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  nowMs = Date.now(),
  toleranceSec = SIGNATURE_TOLERANCE_SEC,
): boolean {
  if (!rawBody || !header || !secret) return false;
  let timestamp = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1' && value) signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs / 1000 - ts) > toleranceSec) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  for (const sig of signatures) {
    let given: Buffer;
    try {
      given = Buffer.from(sig, 'hex');
    } catch {
      continue;
    }
    if (given.length !== expected.length) continue;
    if (crypto.timingSafeEqual(given, expected)) return true;
  }
  return false;
}

export interface BillingEventAction {
  kind: 'grant' | 'revoke' | 'ignore';
  subject?: BillingSubject;
  plan?: BillingPlan;
  status?: BillingStatus;
  customerId?: string;
  subscriptionId?: string;
  currentPeriodEnd?: number;
}

function asPlan(value: unknown): BillingPlan | null {
  return value === 'plus' || value === 'server' ? value : null;
}

function asStatus(value: unknown): BillingStatus {
  const allowed: BillingStatus[] = ['active', 'trialing', 'past_due', 'unpaid', 'canceled', 'incomplete'];
  return allowed.includes(value as BillingStatus) ? (value as BillingStatus) : 'active';
}

function periodEndMs(value: unknown): number | undefined {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Turn a Stripe event into an entitlement change. Pure, so the whole matrix is
 * testable without the network or a signature.
 *
 * `checkout.session.completed` carries the plan/subject we put in metadata;
 * subscription events may arrive later (renewals, cancellation) and carry the
 * same metadata copied onto the subscription by `subscription_data`.
 */
export function mapStripeEvent(event: unknown): BillingEventAction {
  const evt = event as {
    type?: string;
    data?: { object?: Record<string, unknown> };
  } | null;
  const type = typeof evt?.type === 'string' ? evt.type : '';
  const obj = evt?.data?.object;
  if (!type || !obj) return { kind: 'ignore' };

  const metadata = (obj.metadata as Record<string, unknown> | undefined) ?? {};
  const subject =
    typeof metadata.subject === 'string'
      ? metadata.subject
      : typeof obj.client_reference_id === 'string'
        ? obj.client_reference_id
        : '';
  const plan = asPlan(metadata.plan);
  const customerId = typeof obj.customer === 'string' ? obj.customer : undefined;
  const subscriptionId = typeof obj.subscription === 'string' ? obj.subscription || undefined : undefined;

  switch (type) {
    case 'checkout.session.completed':
      // Only a paid/trialing subscription is a grant; an async payment method can
      // complete the session before the money settles.
      if (obj.payment_status && obj.payment_status !== 'paid' && obj.payment_status !== 'no_payment_required') {
        return { kind: 'ignore' };
      }
      return subject && plan
        ? { kind: 'grant', subject, plan, status: 'active', customerId, subscriptionId }
        : { kind: 'ignore' };

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      if (!subject || !plan) return { kind: 'ignore' };
      const status = asStatus(obj.status);
      const end = periodEndMs(obj.current_period_end);
      if (status === 'canceled' || status === 'unpaid') {
        return { kind: 'revoke', subject, subscriptionId, customerId };
      }
      return { kind: 'grant', subject, plan, status, customerId, subscriptionId, currentPeriodEnd: end };
    }

    case 'customer.subscription.deleted':
      return subject ? { kind: 'revoke', subject, subscriptionId, customerId } : { kind: 'ignore' };

    default:
      return { kind: 'ignore' };
  }
}

/** Apply a mapped action to the store. */
export function applyBillingEvent(action: BillingEventAction): void {
  if (action.kind === 'ignore' || !action.subject) return;
  if (action.kind === 'revoke') {
    revokeEntitlement(action.subject);
    return;
  }
  if (!action.plan) return;
  grantEntitlement(action.subject, {
    plan: action.plan,
    status: action.status ?? 'active',
    customerId: action.customerId,
    subscriptionId: action.subscriptionId,
    currentPeriodEnd: action.currentPeriodEnd,
  });
}
