// backend/src/adapters/payment/KofiPaymentAdapter.js

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ValidationError } from '../../domain/errors.js';

/**
 * 20260903 ++ RG #kofi_no_checkout_api
 * Ko-fi has no endpoint to open a payment session: the payer always lands on the
 * creator's own static Ko-fi page, and the amount there is whatever they type — the
 * owner has accepted that as fine for the amounts involved here. Because there is no
 * session to tag, this adapter mints the reference itself and asks the payer to carry
 * it into Ko-fi's free-text message field, rather than receiving one back from a
 * provider call the way Stripe/PayPal do.
 *
 * Excludes 0/O/1/I/L: read aloud or typed on a phone keyboard, those are exactly the
 * characters a payer mistypes into Ko-fi's message field.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CODE_PATTERN = new RegExp(`INK-[${CODE_ALPHABET}]{${CODE_LENGTH}}`);

/**
 * Ko-fi over its documented webhook shape rather than an SDK — there is no official
 * one. Nothing Ko-fi-shaped escapes this file — see PaymentPort.
 *
 * Two things differ from Stripe/PayPal and shape the code below:
 *
 * - **No signature, a shared secret.** Ko-fi echoes a static `verification_token`
 *   inside the payload instead of signing the request; comparison is what stands in
 *   for authentication here.
 * - **No reference comes back.** `verifyCallback` has to find the code this adapter
 *   handed out inside whatever free text the payer typed, and fall back to logging an
 *   unmatched donation when it cannot — see kofi_unmatched_donations in schema.sql.
 *
 * Satisfies the PaymentPort contract.
 */
export class KofiPaymentAdapter {
  /**
   * @param {object} credentials
   * @param {string} credentials.webhookSecret
   * @param {string} [credentials.pageUrl]
   * @param {import('../../ports/PrintJobRepository.js').PrintJobRepository} credentials.jobs
   * @param {import('../../ports/UnmatchedDonationRepository.js').UnmatchedDonationRepository} credentials.unmatchedDonations
   */
  constructor({ webhookSecret, pageUrl, jobs, unmatchedDonations }) {
    if (!webhookSecret) {
      throw new Error('Ko-fi adapter needs the verification token configured on the webhook');
    }
    if (!jobs || !unmatchedDonations) {
      throw new Error('Ko-fi adapter needs both the print job and unmatched-donation repositories');
    }
    this.webhookSecret = webhookSecret;
    this.pageUrl = pageUrl ?? '';
    this.jobs = jobs;
    this.unmatchedDonations = unmatchedDonations;
  }

  /**
   * @param {import('../../ports/PaymentPort.js').CheckoutRequest} request
   * @returns {Promise<import('../../ports/PaymentPort.js').CheckoutTicket>}
   */
  async createCheckout(request) {
    if (!this.pageUrl) {
      throw new Error('KOFI_PAGE_URL is not configured');
    }

    const code = generateCode();
    const url = new URL(this.pageUrl);
    // Best-effort prefill: Ko-fi does not document this as part of a stable contract,
    // and the payer can freely change it on the page. That is accepted here — see the
    // #kofi_no_checkout_api note above.
    url.searchParams.set('amount', amountFromCents(request.amountCents));

    return { paymentRef: code, redirectUrl: url.toString(), redirectMode: 'newTab' };
  }

  /**
   * @param {Buffer} rawBody
   * @returns {Promise<import('../../ports/PaymentPort.js').PaymentConfirmation>}
   */
  async verifyCallback(rawBody) {
    const payload = parseKofiPayload(rawBody);

    if (!safeEquals(String(payload.verification_token ?? ''), this.webhookSecret)) {
      throw new ValidationError('Ko-fi verification token does not match');
    }

    // Shop orders, memberships and commissions are not something this app sells: only
    // a plain donation can ever be the payment for a print job.
    if (payload.type !== 'Donation') {
      return { paymentRef: '', amountCents: 0, paid: false };
    }

    const transactionId = String(payload.kofi_transaction_id ?? '');
    if (!transactionId) throw new ValidationError('Ko-fi donation carried no transaction id');

    const amountCents = centsFromAmount(payload.amount);
    const code = findCode(`${payload.message ?? ''} ${payload.from_name ?? ''}`);

    if (code) {
      const job = await this.jobs.findByPaymentRef(code);
      if (job) return { paymentRef: code, amountCents, paid: true };
    }

    // 20260903 ++ RG #kofi_unmatched_fallback
    // No code, or a code that does not name a real job (typo, stale tab): logged for
    // an admin to attach by hand rather than thrown, which would make Ko-fi retry a
    // callback that will never resolve itself. See MatchKofiDonation.
    await this.unmatchedDonations.save({
      id: randomUUID(),
      kofiTransactionId: transactionId,
      amountCents,
      fromName: payload.from_name ?? null,
      message: payload.message ?? null,
      email: payload.email ?? null,
      receivedAt: new Date(),
      matchedJobId: null,
      matchedAt: null
    });

    return { paymentRef: '', amountCents, paid: false };
  }
}

/** @returns {string} */
function generateCode() {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return `INK-${code}`;
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function findCode(text) {
  const match = text.toUpperCase().match(CODE_PATTERN);
  return match ? match[0] : null;
}

/**
 * Ko-fi's `data` field arrives as a JSON string inside an application/x-www-form-urlencoded
 * body, not as JSON directly.
 *
 * @param {Buffer} rawBody
 * @returns {Record<string, any>}
 */
function parseKofiPayload(rawBody) {
  const form = new URLSearchParams(rawBody.toString('utf8'));
  const data = form.get('data');
  if (!data) throw new ValidationError('Ko-fi callback carried no data field');

  try {
    return JSON.parse(data);
  } catch {
    throw new ValidationError('Ko-fi callback data is not valid JSON');
  }
}

/**
 * @param {string} a
 * @param {string} b
 */
function safeEquals(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Cents to the decimal string Ko-fi's `?amount=` wants, without ever going through a
 * float. Same technique as the PayPal adapter.
 *
 * @param {number} cents
 */
function amountFromCents(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * And back again, parsed off the string rather than multiplied by 100.
 *
 * @param {unknown} value
 */
function centsFromAmount(value) {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new ValidationError(`Ko-fi sent an amount this adapter will not guess at: ${value}`);
  }
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
