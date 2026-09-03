// backend/src/application/RequestPrint.js

import { NotFoundError, ValidationError } from '../domain/errors.js';
import { formatAttribution } from '../domain/identity.js';
import { PrintJob } from '../domain/PrintJob.js';

/**
 * Turns "print this message" into a queued job plus a checkout to pay for it.
 */
export class RequestPrint {
  /**
   * @param {object} deps
   * @param {import('../ports/MessageRepository.js').MessageRepository} deps.messages
   * @param {import('../ports/PrintJobRepository.js').PrintJobRepository} deps.jobs
   * @param {import('../ports/PaymentPort.js').PaymentPort} deps.payments
   * @param {string} deps.publicBaseUrl
   */
  constructor({ messages, jobs, payments, publicBaseUrl }) {
    this.messages = messages;
    this.jobs = jobs;
    this.payments = payments;
    this.publicBaseUrl = publicBaseUrl;
  }

  /**
   * @param {object} input
   * @param {string} input.messageId
   * @param {unknown} [input.printerInstagram]
   * @param {number} input.amountCents
   * @returns {Promise<{ job: PrintJob, redirectUrl: string, redirectMode?: 'navigate' | 'newTab' }>}
   */
  async execute(input) {
    const message = await this.messages.findById(input.messageId);
    if (!message) throw new NotFoundError('Message', input.messageId);

    // Only what the board actually shows can be sent to paper.
    if (!message.isPublished) {
      throw new ValidationError('Only an approved message can be printed');
    }

    const job = PrintJob.request({
      messageId: message.id,
      printerInstagram: input.printerInstagram,
      amountCents: input.amountCents
    });

    const printer = job.printerInstagram ? `@${job.printerInstagram}` : null;
    const checkout = await this.payments.createCheckout({
      jobId: job.id,
      amountCents: job.amountCents,
      description: formatAttribution(message.author, printer),
      returnUrl: `${this.publicBaseUrl}/job/${job.id}`
    });

    job.paymentRef = checkout.paymentRef;
    await this.jobs.save(job);

    return { job, redirectUrl: checkout.redirectUrl, redirectMode: checkout.redirectMode };
  }
}
