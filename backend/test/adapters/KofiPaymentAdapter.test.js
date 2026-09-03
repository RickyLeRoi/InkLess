// backend/test/adapters/KofiPaymentAdapter.test.js

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { KofiPaymentAdapter } from '../../src/adapters/payment/KofiPaymentAdapter.js';

const WEBHOOK_SECRET = 'kofi-verification-token';

/** In-memory stand-ins, just enough of the two ports the adapter actually calls. */
function fakeRepos() {
  /** @type {Map<string, any>} */
  const jobsByPaymentRef = new Map();
  /** @type {any[]} */
  const savedDonations = [];

  return {
    jobs: {
      /** @param {string} paymentRef */
      async findByPaymentRef(paymentRef) {
        return jobsByPaymentRef.get(paymentRef) ?? null;
      }
    },
    unmatchedDonations: {
      /** @param {any} donation */
      async save(donation) {
        savedDonations.push(donation);
      }
    },
    jobsByPaymentRef,
    savedDonations
  };
}

/**
 * @param {ReturnType<typeof fakeRepos>} repos
 * @param {string} [pageUrl]
 */
function buildAdapter(repos, pageUrl = 'https://ko-fi.com/rickydev') {
  return new KofiPaymentAdapter({
    webhookSecret: WEBHOOK_SECRET,
    pageUrl,
    jobs: /** @type {any} */ (repos.jobs),
    unmatchedDonations: /** @type {any} */ (repos.unmatchedDonations)
  });
}

/**
 * @param {object} overrides
 * @param {string} [overrides.type]
 * @param {string} [overrides.amount]
 * @param {string} [overrides.message]
 * @param {string} [overrides.fromName]
 * @param {string} [overrides.token]
 * @param {string} [overrides.transactionId]
 */
function donationBody(overrides = {}) {
  const payload = {
    verification_token: overrides.token ?? WEBHOOK_SECRET,
    kofi_transaction_id: overrides.transactionId ?? randomUUID(),
    type: overrides.type ?? 'Donation',
    amount: overrides.amount ?? '0.60',
    message: overrides.message ?? '',
    from_name: overrides.fromName ?? 'Un sostenitore',
    email: 'payer@example.invalid'
  };
  const form = new URLSearchParams({ data: JSON.stringify(payload) });
  return Buffer.from(form.toString(), 'utf8');
}

describe('KofiPaymentAdapter.createCheckout', () => {
  it('mints its own code and points at the configured Ko-fi page', async () => {
    const adapter = buildAdapter(fakeRepos());
    const ticket = await adapter.createCheckout({
      jobId: 'job-1',
      amountCents: 60,
      description: 'Stampa di un messaggio',
      returnUrl: 'https://example.invalid/job/job-1'
    });

    assert.match(ticket.paymentRef, /^INK-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    assert.equal(ticket.redirectMode, 'newTab');
    const url = new URL(ticket.redirectUrl);
    assert.equal(url.origin + url.pathname, 'https://ko-fi.com/rickydev');
    assert.equal(url.searchParams.get('amount'), '0.60');
  });

  it('refuses to open a checkout with no page configured', async () => {
    const adapter = buildAdapter(fakeRepos(), '');
    await assert.rejects(
      () =>
        adapter.createCheckout({
          jobId: 'job-1',
          amountCents: 60,
          description: 'x',
          returnUrl: 'https://example.invalid/job/job-1'
        }),
      /KOFI_PAGE_URL/
    );
  });
});

describe('KofiPaymentAdapter.verifyCallback', () => {
  /** @type {ReturnType<typeof fakeRepos>} */
  let repos;

  beforeEach(() => {
    repos = fakeRepos();
  });

  it('refuses a callback with the wrong verification token', async () => {
    await assert.rejects(
      () => buildAdapter(repos).verifyCallback(donationBody({ token: 'not-it' })),
      /verification token/
    );
  });

  it('confirms payment when the payer carried the code in the message', async () => {
    repos.jobsByPaymentRef.set('INK-ABCDEF', { id: 'job-1' });

    const confirmation = await buildAdapter(repos).verifyCallback(
      donationBody({ message: 'un caffè per te! INK-ABCDEF grazie', amount: '1.00' })
    );

    assert.deepEqual(confirmation, { paymentRef: 'INK-ABCDEF', amountCents: 100, paid: true });
    assert.equal(repos.savedDonations.length, 0);
  });

  it('finds the code in from_name when the message is empty', async () => {
    repos.jobsByPaymentRef.set('INK-ZZYYXX', { id: 'job-2' });

    const confirmation = await buildAdapter(repos).verifyCallback(
      donationBody({ message: '', fromName: 'INK-ZZYYXX' })
    );

    assert.equal(confirmation.paymentRef, 'INK-ZZYYXX');
    assert.equal(confirmation.paid, true);
  });

  it('logs an unmatched donation instead of throwing when no code is found', async () => {
    const confirmation = await buildAdapter(repos).verifyCallback(
      donationBody({ message: 'grazie del bel progetto', amount: '2.00' })
    );

    assert.equal(confirmation.paid, false);
    assert.equal(repos.savedDonations.length, 1);
    assert.equal(repos.savedDonations[0].amountCents, 200);
    assert.equal(repos.savedDonations[0].message, 'grazie del bel progetto');
  });

  it('logs an unmatched donation when the code does not name a real job', async () => {
    const confirmation = await buildAdapter(repos).verifyCallback(
      donationBody({ message: 'INK-NOPE12' })
    );

    assert.equal(confirmation.paid, false);
    assert.equal(repos.savedDonations.length, 1);
  });

  it('ignores anything that is not a plain donation', async () => {
    const confirmation = await buildAdapter(repos).verifyCallback(
      donationBody({ type: 'Subscription' })
    );

    assert.deepEqual(confirmation, { paymentRef: '', amountCents: 0, paid: false });
    assert.equal(repos.savedDonations.length, 0);
  });

  it('parses the amount without ever going through a float', async () => {
    repos.jobsByPaymentRef.set('INK-CENTS1', { id: 'job-3' });

    const confirmation = await buildAdapter(repos).verifyCallback(
      donationBody({ message: 'INK-CENTS1', amount: '0.29' })
    );

    assert.equal(confirmation.amountCents, 29);
  });
});
