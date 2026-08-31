// backend/src/application/TrackPrintJob.js

import { NotFoundError } from '../domain/errors.js';

/**
 * Outcome reporting coming back from the hardware node.
 */
export class TrackPrintJob {
  /**
   * @param {object} deps
   * @param {import('../ports/MessageRepository.js').MessageRepository} deps.messages
   * @param {import('../ports/PrintJobRepository.js').PrintJobRepository} deps.jobs
   */
  constructor({ messages, jobs }) {
    this.messages = messages;
    this.jobs = jobs;
  }

  /**
   * @param {string} jobId
   * @returns {Promise<import('../domain/PrintJob.js').PrintJob>}
   */
  async #load(jobId) {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new NotFoundError('PrintJob', jobId);
    return job;
  }

  /** @param {string} jobId */
  async start(jobId) {
    const job = await this.#load(jobId);
    job.start();
    await this.jobs.save(job);
    return job;
  }

  /**
   * @param {string} jobId
   * @param {string | null} [videoUrl]
   */
  async complete(jobId, videoUrl = null) {
    const job = await this.#load(jobId);
    job.complete(videoUrl);
    await this.jobs.save(job);

    // The board counter only moves once paper has actually come out of the printer.
    const message = await this.messages.findById(job.messageId);
    if (message) {
      message.registerPrint();
      await this.messages.save(message);
    }

    return job;
  }

  /**
   * @param {string} jobId
   * @param {string} reason
   */
  async fail(jobId, reason) {
    const job = await this.#load(jobId);
    job.fail(reason);
    await this.jobs.save(job);
    return job;
  }

  /** @param {string} jobId */
  async status(jobId) {
    return this.#load(jobId);
  }
}
