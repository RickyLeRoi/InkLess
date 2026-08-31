// backend/src/adapters/payment/FakePaymentAdapter.js

import { randomUUID } from 'node:crypto';
import { ValidationError } from '../../domain/errors.js';

/**
 * Local stand-in for a real provider: no network, no keys, deterministic.
 * Selected with PAYMENT_PROVIDER=fake, which loadConfig refuses to default to
 * once NODE_ENV is production.
 *
 * Satisfies the PaymentPort contract.
 */
export class FakePaymentAdapter {
  constructor() {
    /** @type {Map<string, { jobId: string, amountCents: number }>} */
    this.issued = new Map();
  }

  /**
   * @param {import('../../ports/PaymentPort.js').CheckoutRequest} request
   * @returns {Promise<import('../../ports/PaymentPort.js').CheckoutTicket>}
   */
  async createCheckout(request) {
    const paymentRef = `fake_${randomUUID()}`;
    this.issued.set(paymentRef, { jobId: request.jobId, amountCents: request.amountCents });
    return {
      paymentRef,
      redirectUrl: `${request.returnUrl}?paymentRef=${encodeURIComponent(paymentRef)}`
    };
  }

  /**
   * @param {Buffer} rawBody
   * @returns {Promise<import('../../ports/PaymentPort.js').PaymentConfirmation>}
   */
  async verifyCallback(rawBody) {
    /** @type {{ paymentRef?: string, paid?: boolean }} */
    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new ValidationError('Callback body is not valid JSON');
    }

    const paymentRef = payload.paymentRef;
    if (!paymentRef) throw new ValidationError('Callback is missing paymentRef');

    const issued = this.issued.get(paymentRef);
    if (!issued) throw new ValidationError('Unknown paymentRef');

    return {
      paymentRef,
      amountCents: issued.amountCents,
      paid: payload.paid !== false
    };
  }
}
