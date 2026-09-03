// backend/src/application/ConfirmPayment.js

import { NotFoundError, ValidationError } from '../domain/errors.js';
import { queuePaidJob } from './queuePaidJob.js';

export class ConfirmPayment {
  /**
   * @param {object} deps
   * @param {import('../ports/MessageRepository.js').MessageRepository} deps.messages
   * @param {import('../ports/PrintJobRepository.js').PrintJobRepository} deps.jobs
   * @param {import('../ports/PaymentPort.js').PaymentPort} deps.payments
   * @param {import('../ports/PrintQueuePort.js').PrintQueuePort} deps.printQueue
   */
  constructor({ messages, jobs, payments, printQueue }) {
    this.messages = messages;
    this.jobs = jobs;
    this.payments = payments;
    this.printQueue = printQueue;
  }

  /**
   * @param {Buffer} rawBody
   * @param {Record<string, string>} headers
   * @returns {Promise<{ queued: boolean, jobId: string | null, reason?: string }>}
   */
  async execute(rawBody, headers) {
    const confirmation = await this.payments.verifyCallback(rawBody, headers);
    if (!confirmation.paid) {
      return { queued: false, jobId: null, reason: 'not_paid' };
    }

    const job = await this.jobs.findByPaymentRef(confirmation.paymentRef);
    if (!job) throw new NotFoundError('PrintJob for payment', confirmation.paymentRef);

    // 20260903 ** RG #donor_controlled_amount
    // Was a strict equality: fine when the provider itself fixes the checkout amount
    // (Stripe, PayPal), but Ko-fi's payer can type anything on the donation page. A
    // callback for less than what was requested is still refused — that is the tier
    // the job was queued for — but paying more now upgrades amountCents before
    // markPaid(), so a generous Ko-fi payer unlocks the video tier automatically
    // (includesVideo is derived from amountCents, nothing else to change).
    if (confirmation.amountCents < job.amountCents) {
      throw new ValidationError('Confirmed amount is lower than the requested job');
    }
    job.amountCents = confirmation.amountCents;

    return queuePaidJob(
      { messages: this.messages, jobs: this.jobs, printQueue: this.printQueue },
      job
    );
  }
}
