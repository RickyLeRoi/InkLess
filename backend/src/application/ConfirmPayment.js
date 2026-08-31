// backend/src/application/ConfirmPayment.js

import { NotFoundError, ValidationError } from '../domain/errors.js';
import { formatAttribution } from '../domain/identity.js';

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

    // The tier that decides "video or no video" is derived from the amount, so a
    // callback claiming a different figure than the job was created with is refused.
    if (confirmation.amountCents !== job.amountCents) {
      throw new ValidationError('Confirmed amount does not match the requested job');
    }

    const justQueued = job.markPaid();
    await this.jobs.save(job);

    if (!justQueued) {
      return { queued: false, jobId: job.id, reason: 'already_processed' };
    }

    const message = await this.messages.findById(job.messageId);
    if (!message) throw new NotFoundError('Message', job.messageId);

    await this.printQueue.publish({
      jobId: job.id,
      text: message.text,
      attribution: formatAttribution(
        message.author,
        job.printerInstagram ? `@${job.printerInstagram}` : null
      ),
      includesVideo: job.includesVideo
    });

    return { queued: true, jobId: job.id };
  }
}
