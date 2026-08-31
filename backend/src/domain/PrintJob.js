// backend/src/domain/PrintJob.js

import { randomUUID } from 'node:crypto';
import { IllegalTransitionError, ValidationError } from './errors.js';
import { normalizeInstagramHandle } from './text.js';

export const PrintJobStatus = Object.freeze({
  AWAITING_PAYMENT: 'awaiting_payment',
  QUEUED: 'queued',
  PRINTING: 'printing',
  COMPLETED: 'completed',
  FAILED: 'failed'
});

/**
 * @typedef {'awaiting_payment' | 'queued' | 'printing' | 'completed' | 'failed'}
 *   PrintJobStatusValue
 */

/**
 * 20260830 ++ RG #money_as_integer_cents
 * Donations are held as integer cents everywhere. The tier boundaries are 0.50 and
 * 1.00 EUR and floating point makes those comparisons a coin toss: 0.1 + 0.2 > 0.3
 * is true in IEEE 754, and a payer sitting exactly on 1.00 must always get the video.
 */
export const MINIMUM_PRINT_CENTS = 51;
export const VIDEO_THRESHOLD_CENTS = 100;

/** @type {Readonly<Record<string, PrintJobStatusValue[]>>} */
const ALLOWED_TRANSITIONS = Object.freeze({
  awaiting_payment: [PrintJobStatus.QUEUED, PrintJobStatus.FAILED],
  queued: [PrintJobStatus.PRINTING, PrintJobStatus.FAILED],
  printing: [PrintJobStatus.COMPLETED, PrintJobStatus.FAILED],
  completed: [],
  failed: []
});

export class PrintJob {
  /**
   * @param {object} state
   * @param {string} state.id
   * @param {string} state.messageId
   * @param {string | null} state.printerInstagram
   * @param {number} state.amountCents
   * @param {string | null} state.paymentRef
   * @param {PrintJobStatusValue} state.status
   * @param {string | null} state.videoUrl
   * @param {Date} state.createdAt
   */
  constructor(state) {
    this.id = state.id;
    this.messageId = state.messageId;
    this.printerInstagram = state.printerInstagram;
    this.amountCents = state.amountCents;
    this.paymentRef = state.paymentRef;
    this.status = state.status;
    this.videoUrl = state.videoUrl;
    this.createdAt = state.createdAt;
    /** @type {string | null} */
    this.failureReason = null;
  }

  /**
   * @param {object} input
   * @param {string} input.messageId
   * @param {unknown} [input.printerInstagram]
   * @param {number} input.amountCents
   * @param {string | null} [input.paymentRef]
   * @param {string} [input.id]
   * @param {Date} [input.now]
   * @returns {PrintJob}
   */
  static request(input) {
    if (!Number.isInteger(input.amountCents)) {
      throw new ValidationError('Donation must be an integer amount of cents');
    }
    if (input.amountCents < MINIMUM_PRINT_CENTS) {
      throw new ValidationError(
        `Donation must exceed ${MINIMUM_PRINT_CENTS - 1} cents to queue a print`
      );
    }
    if (!input.messageId) {
      throw new ValidationError('A print job must reference a message');
    }

    return new PrintJob({
      id: input.id ?? randomUUID(),
      messageId: input.messageId,
      printerInstagram: normalizeInstagramHandle(input.printerInstagram),
      amountCents: input.amountCents,
      paymentRef: input.paymentRef ?? null,
      status: PrintJobStatus.AWAITING_PAYMENT,
      videoUrl: null,
      createdAt: input.now ?? new Date()
    });
  }

  /**
   * 20260830 ++ RG #webhook_idempotency
   * Payment providers retry callbacks, so confirming an already-paid job is a no-op
   * rather than an error: a duplicate delivery must never queue a second print.
   *
   * @returns {boolean} true when this call is the one that queued the job
   */
  markPaid() {
    if (this.status !== PrintJobStatus.AWAITING_PAYMENT) return false;
    this.status = PrintJobStatus.QUEUED;
    return true;
  }

  /** @returns {boolean} */
  get includesVideo() {
    return this.amountCents >= VIDEO_THRESHOLD_CENTS;
  }

  /** @returns {boolean} */
  get isSettled() {
    return this.status === PrintJobStatus.COMPLETED || this.status === PrintJobStatus.FAILED;
  }

  /** @param {PrintJobStatusValue} next */
  #transitionTo(next) {
    const allowed = ALLOWED_TRANSITIONS[this.status] ?? [];
    if (!allowed.includes(next)) {
      throw new IllegalTransitionError(this.status, next);
    }
    this.status = next;
  }

  start() {
    this.#transitionTo(PrintJobStatus.PRINTING);
  }

  /** @param {string | null} [videoUrl] */
  complete(videoUrl = null) {
    if (videoUrl && !this.includesVideo) {
      throw new ValidationError('This tier did not pay for a video clip');
    }
    this.#transitionTo(PrintJobStatus.COMPLETED);
    this.videoUrl = videoUrl;
  }

  /** @param {string} [reason] */
  fail(reason = 'unknown') {
    this.#transitionTo(PrintJobStatus.FAILED);
    this.failureReason = reason;
  }

  /** @returns {object} */
  toPublicJSON() {
    return {
      id: this.id,
      messageId: this.messageId,
      printer: this.printerInstagram ? `@${this.printerInstagram}` : null,
      status: this.status,
      includesVideo: this.includesVideo,
      videoUrl: this.videoUrl,
      createdAt: this.createdAt.toISOString()
    };
  }
}
