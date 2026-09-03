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
 * Donations are held as integer cents everywhere. The tier boundaries are 1.00 and
 * 2.00 EUR and floating point makes those comparisons a coin toss: 0.1 + 0.2 > 0.3
 * is true in IEEE 754, and a payer sitting exactly on 2.00 must always get the video.
 *
 * 20260903 ** RG #kofi_minimum_is_one_euro
 * Ko-fi refuses donations below 1.00 EUR outright, so the print floor moved up to
 * match it and is now inclusive rather than "more than 0.50" — there is no longer a
 * lower tier for it to be exclusive against.
 */
export const MINIMUM_PRINT_CENTS = 100;
export const VIDEO_THRESHOLD_CENTS = 200;

/** @type {Readonly<Record<string, PrintJobStatusValue[]>>} */
const ALLOWED_TRANSITIONS = Object.freeze({
  awaiting_payment: [PrintJobStatus.QUEUED, PrintJobStatus.FAILED],
  queued: [PrintJobStatus.PRINTING, PrintJobStatus.FAILED],
  printing: [PrintJobStatus.COMPLETED, PrintJobStatus.FAILED],
  completed: [],
  failed: []
});

/**
 * Schemes a clip URL may carry. An allowlist rather than a 'javascript:' blocklist:
 * the danger is any scheme the browser executes, and that set is longer than it looks
 * (data:, blob:, vbscript:). http is in because the clip is served over plain HTTP in
 * development and in the e2e stack; in production it inherits the site's https.
 */
const CLIP_URL_SCHEMES = Object.freeze(['https:', 'http:']);

/**
 * @param {string} value
 */
function assertSafeClipUrl(value) {
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError('Clip URL is not a URL');
  }
  if (!CLIP_URL_SCHEMES.includes(parsed.protocol)) {
    throw new ValidationError(`Clip URL scheme is not allowed: ${parsed.protocol}`);
  }
}

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

  /**
   * 20260831 ** RG #clip_url_must_be_safe
   * The URL comes off the hardware node and ends up in an href and a <video src>.
   * The route schema only asks AJV for 'a URI', which "javascript:alert(1)" satisfies
   * perfectly well. The node is authenticated, so this is depth rather than a live
   * hole — but a scheme allowlist is one line and the alternative is a stored XSS.
   *
   * @param {string | null} [videoUrl]
   */
  complete(videoUrl = null) {
    if (videoUrl && !this.includesVideo) {
      throw new ValidationError('This tier did not pay for a video clip');
    }
    if (videoUrl) assertSafeClipUrl(videoUrl);
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
