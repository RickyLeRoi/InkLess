// backend/src/domain/Message.js

import { randomUUID } from 'node:crypto';
import { IllegalTransitionError, ValidationError } from './errors.js';
import { formatAuthor } from './identity.js';
import { normalizeInstagramHandle, normalizeMessageText } from './text.js';

export const MessageStatus = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected'
});

/** @typedef {'pending' | 'approved' | 'rejected'} MessageStatusValue */

/** @type {Readonly<Record<string, MessageStatusValue[]>>} */
const ALLOWED_TRANSITIONS = Object.freeze({
  pending: [MessageStatus.APPROVED, MessageStatus.REJECTED],
  approved: [MessageStatus.REJECTED],
  rejected: [MessageStatus.APPROVED]
});

export class Message {
  /**
   * @param {object} state
   * @param {string} state.id
   * @param {string} state.originalText
   * @param {string} state.text
   * @param {string | null} state.authorInstagram
   * @param {number | null} state.authorSequence
   * @param {MessageStatusValue} state.status
   * @param {number} state.printCount
   * @param {Date} state.createdAt
   * @param {Date | null} [state.llmReviewedAt]
   * @param {string[]} [state.moderationReasons]
   */
  constructor(state) {
    this.id = state.id;
    this.originalText = state.originalText;
    this.text = state.text;
    this.authorInstagram = state.authorInstagram;
    this.authorSequence = state.authorSequence;
    this.status = state.status;
    this.printCount = state.printCount;
    this.createdAt = state.createdAt;
    this.llmReviewedAt = state.llmReviewedAt ?? null;
    /** @type {string[]} */
    this.moderationReasons = state.moderationReasons ?? [];
  }

  /**
   * Why the pipeline put this message where it did. Persisted so the admin panel can
   * say "the handle tripped the filter" instead of just "somebody look at this".
   *
   * @param {string[]} reasons
   */
  recordModeration(reasons) {
    this.moderationReasons = [...new Set(reasons)];
  }

  /**
   * @param {object} input
   * @param {unknown} input.text
   * @param {unknown} [input.authorInstagram]
   * @param {number | null} [input.anonymousSequence] required when no handle is given
   * @param {string} [input.id]
   * @param {Date} [input.now]
   * @returns {Message}
   */
  static submit(input) {
    const text = normalizeMessageText(input.text);
    const authorInstagram = normalizeInstagramHandle(input.authorInstagram);
    const anonymousSequence = input.anonymousSequence ?? null;

    if (!authorInstagram && anonymousSequence === null) {
      throw new ValidationError('An anonymous sequence is required when no handle is given');
    }

    return new Message({
      id: input.id ?? randomUUID(),
      originalText: text,
      text,
      authorInstagram,
      authorSequence: authorInstagram ? null : anonymousSequence,
      status: MessageStatus.PENDING,
      printCount: 0,
      createdAt: input.now ?? new Date()
    });
  }

  /** @returns {string} */
  get author() {
    return formatAuthor({
      instagramHandle: this.authorInstagram,
      anonymousSequence: this.authorSequence
    });
  }

  /** @returns {boolean} */
  get isPublished() {
    return this.status === MessageStatus.APPROVED;
  }

  /** @returns {boolean} */
  get wasCensored() {
    return this.text !== this.originalText;
  }

  /**
   * True when the model has already looked at this one and could not decide, so it
   * is genuinely waiting on a person.
   *
   * @returns {boolean}
   */
  get needsHuman() {
    return this.status === MessageStatus.PENDING && this.llmReviewedAt !== null;
  }

  /**
   * 20260831 ++ RG #llm_review_marker
   * Stamped whatever the model concluded, including "no idea". That is the whole
   * point: an undecided message stays in the queue but is never paid for twice.
   *
   * @param {Date} [now]
   */
  markLlmReviewed(now = new Date()) {
    this.llmReviewedAt = now;
  }

  /** @param {MessageStatusValue} next */
  #transitionTo(next) {
    const allowed = ALLOWED_TRANSITIONS[this.status] ?? [];
    if (!allowed.includes(next)) {
      throw new IllegalTransitionError(this.status, next);
    }
    this.status = next;
  }

  approve() {
    this.#transitionTo(MessageStatus.APPROVED);
  }

  reject() {
    this.#transitionTo(MessageStatus.REJECTED);
  }

  /**
   * Replaces the published text while keeping the submission verbatim for audit.
   *
   * @param {unknown} replacement
   */
  censor(replacement) {
    if (this.status === MessageStatus.REJECTED) {
      throw new IllegalTransitionError(this.status, 'censored');
    }
    this.text = normalizeMessageText(replacement);
  }

  /**
   * Replaces the author's handle, or strips it back to a generated identity.
   *
   * The admin can edit the name as well as the body: a handle that trips the filter
   * is often fixable rather than fatal, and blanking it must still leave the message
   * with exactly one identity.
   *
   * @param {string | null} handle already normalised, or null to anonymise
   * @param {number | null} [anonymousSequence] required when anonymising
   */
  censorHandle(handle, anonymousSequence = null) {
    if (this.status === MessageStatus.REJECTED) {
      throw new IllegalTransitionError(this.status, 'censored');
    }

    if (handle) {
      this.authorInstagram = handle;
      this.authorSequence = null;
      return;
    }

    const sequence = anonymousSequence ?? this.authorSequence;
    if (sequence === null) {
      throw new ValidationError('Anonymising a handle needs an anonymous sequence');
    }
    this.authorInstagram = null;
    this.authorSequence = sequence;
  }

  /**
   * 20260830 ++ RG #print_counter
   * Only a physically completed print may move this counter — it is the number the
   * board shows, and inflating it on queue would let an unpaid or failed job lie.
   */
  registerPrint() {
    if (!this.isPublished) {
      throw new IllegalTransitionError(this.status, 'printed');
    }
    this.printCount += 1;
  }

  /** @returns {object} */
  toPublicJSON() {
    return {
      id: this.id,
      text: this.text,
      author: this.author,
      authorInstagram: this.authorInstagram,
      printCount: this.printCount,
      createdAt: this.createdAt.toISOString()
    };
  }
}
