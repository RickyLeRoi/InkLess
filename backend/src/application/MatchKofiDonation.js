// backend/src/application/MatchKofiDonation.js

import { NotFoundError, ValidationError } from '../domain/errors.js';
import { queuePaidJob } from './queuePaidJob.js';

/**
 * The manual half of the Ko-fi flow: attaches a donation the webhook could not place
 * on its own (see KofiPaymentAdapter#kofi_unmatched_fallback) to the print job an
 * admin says it paid for, then runs the exact same paid-tail as ConfirmPayment — a
 * donation queues the same print whether the code was read automatically or by a
 * human.
 */
export class MatchKofiDonation {
  /**
   * @param {object} deps
   * @param {import('../ports/MessageRepository.js').MessageRepository} deps.messages
   * @param {import('../ports/PrintJobRepository.js').PrintJobRepository} deps.jobs
   * @param {import('../ports/UnmatchedDonationRepository.js').UnmatchedDonationRepository} deps.unmatchedDonations
   * @param {import('../ports/PrintQueuePort.js').PrintQueuePort} deps.printQueue
   */
  constructor({ messages, jobs, unmatchedDonations, printQueue }) {
    this.messages = messages;
    this.jobs = jobs;
    this.unmatchedDonations = unmatchedDonations;
    this.printQueue = printQueue;
  }

  /** @returns {Promise<import('../ports/UnmatchedDonationRepository.js').UnmatchedDonation[]>} */
  async listUnmatched() {
    return this.unmatchedDonations.findUnmatched();
  }

  /**
   * @param {string} donationId
   * @param {string} jobId
   * @returns {Promise<{ queued: boolean, jobId: string | null, reason?: string }>}
   */
  async execute(donationId, jobId) {
    const donation = await this.unmatchedDonations.findById(donationId);
    if (!donation) throw new NotFoundError('Ko-fi donation', donationId);
    if (donation.matchedJobId) {
      throw new ValidationError('This donation is already matched to a job');
    }

    const job = await this.jobs.findById(jobId);
    if (!job) throw new NotFoundError('PrintJob', jobId);

    if (donation.amountCents < job.amountCents) {
      throw new ValidationError('Donation is smaller than the requested job');
    }
    job.amountCents = donation.amountCents;

    const result = await queuePaidJob(
      { messages: this.messages, jobs: this.jobs, printQueue: this.printQueue },
      job
    );
    await this.unmatchedDonations.markMatched(donationId, jobId);
    return result;
  }
}
