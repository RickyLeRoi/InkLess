// backend/src/adapters/payment/StripePaymentAdapter.js

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ValidationError } from '../../domain/errors.js';

const STRIPE_API = 'https://api.stripe.com/v1';
const CURRENCY = 'eur';
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Talks to Stripe over its REST API rather than the SDK: the two calls we need are
 * a form POST and an HMAC check, which is not worth a dependency tree.
 *
 * Nothing Stripe-shaped escapes this file — see PaymentPort for why.
 *
 * Satisfies the PaymentPort contract.
 */
export class StripePaymentAdapter {
  /**
   * @param {{ secretKey: string, webhookSecret: string }} credentials
   */
  constructor({ secretKey, webhookSecret }) {
    if (!secretKey || !webhookSecret) {
      throw new Error('Stripe adapter needs both a secret key and a webhook secret');
    }
    this.secretKey = secretKey;
    this.webhookSecret = webhookSecret;
  }

  /**
   * @param {import('../../ports/PaymentPort.js').CheckoutRequest} request
   * @returns {Promise<import('../../ports/PaymentPort.js').CheckoutTicket>}
   */
  async createCheckout(request) {
    const form = new URLSearchParams({
      mode: 'payment',
      success_url: `${request.returnUrl}?paid=1`,
      cancel_url: `${request.returnUrl}?paid=0`,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': CURRENCY,
      'line_items[0][price_data][unit_amount]': String(request.amountCents),
      'line_items[0][price_data][product_data][name]': request.description,
      'metadata[jobId]': request.jobId
    });

    const response = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Stripe rejected the checkout session: ${response.status} ${detail}`);
    }

    const session = await response.json();
    return { paymentRef: session.id, redirectUrl: session.url };
  }

  /**
   * 20260830 ++ RG #stripe_signature_check
   * Verifies the t=/v1= envelope over the raw bytes, with a replay window. An
   * unverified webhook is a free print, so a failure here must never fall through
   * to "assume paid".
   *
   * @param {Buffer} rawBody
   * @param {Record<string, string>} headers
   * @returns {Promise<import('../../ports/PaymentPort.js').PaymentConfirmation>}
   */
  async verifyCallback(rawBody, headers) {
    const header = headers['stripe-signature'];
    if (!header) throw new ValidationError('Missing Stripe signature header');

    const parts = Object.fromEntries(
      header.split(',').map((piece) => {
        const [key, value] = piece.split('=');
        return [key.trim(), value];
      })
    );

    const timestamp = Number.parseInt(parts.t ?? '', 10);
    if (!Number.isInteger(timestamp)) {
      throw new ValidationError('Malformed Stripe signature header');
    }

    const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
    if (age > SIGNATURE_TOLERANCE_SECONDS) {
      throw new ValidationError('Stripe signature is outside the replay window');
    }

    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${rawBody.toString('utf8')}`)
      .digest('hex');

    if (!safeEquals(expected, parts.v1 ?? '')) {
      throw new ValidationError('Stripe signature does not match');
    }

    const event = JSON.parse(rawBody.toString('utf8'));
    const session = event?.data?.object ?? {};

    return {
      paymentRef: session.id,
      amountCents: session.amount_total,
      paid: event.type === 'checkout.session.completed' && session.payment_status === 'paid'
    };
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
