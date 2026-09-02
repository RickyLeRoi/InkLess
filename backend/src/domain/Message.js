// backend/src/domain/Message.js

import { randomUUID } from 'node:crypto';
import { applyCensorship, maskWord, normalizeWordIndices, readCensorship } from './censor.js';
import { IllegalTransitionError, ValidationError } from './errors.js';
import { formatAuthor } from './identity.js';
import { normalizeInstagramHandle, normalizeMessageText } from './text.js';

export const MessageStatus = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected'
});

/** @typedef {'pending' | 'approved' | 'rejected'} MessageStatusValue */

/**
 * 20260902 ++ RG #appeal
 * An appeal is a moderation reason rather than a status of its own: the filter is
 * deliberately blunt, so a rejected author needs a way to reach a human, but nothing
 * about the message changes until that human decides. The admin already has the
 * rejected → approved move.
 */
export const APPEAL_REASON = 'appeal_requested';

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
   * @param {boolean} [state.handleCensored]
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
    this.handleCensored = state.handleCensored ?? false;
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
    const label = formatAuthor({
      instagramHandle: this.authorInstagram,
      anonymousSequence: this.authorSequence
    });
    if (!this.handleCensored) return label;

    // The "@" is punctuation, not part of the name: masking it would eat the one
    // character that says this is an Instagram handle at all.
    return label.startsWith('@') ? `@${maskWord(label.slice(1))}` : maskWord(label);
  }

  /** @returns {boolean} */
  get appealRequested() {
    return this.moderationReasons.includes(APPEAL_REASON);
  }

  /**
   * Asks for a human to look again at a rejection.
   *
   * @returns {boolean} false when an appeal is already on record, so a double tap or
   *   a retried request cannot stack them
   */
  requestAppeal() {
    if (this.status !== MessageStatus.REJECTED) {
      throw new IllegalTransitionError(this.status, 'appealed');
    }
    if (this.appealRequested) return false;

    this.moderationReasons = [...this.moderationReasons, APPEAL_REASON];
    return true;
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
   * 20260903 ** RG #censor_instead_of_rewrite
   * Blacks out whole words of the submission. The published text is recomputed from
   * the verbatim original every time, so lifting a censorship is passing the same set
   * without that index — there is no un-censor operation to get wrong, and the admin
   * has no way to make the message say something the author did not write.
   *
   * A rejected message may be censored: the appeal path is reject → black out the word
   * → publish, and until it is approved nothing of it is on the board anyway.
   *
   * @param {unknown} indices
   */
  censorWords(indices) {
    this.text = applyCensorship(this.originalText, normalizeWordIndices(indices));
  }

  /** @returns {number[]} the words currently blacked out */
  get censoredWords() {
    return readCensorship(this.originalText, this.text) ?? [];
  }

  /**
   * A body the old free-text panel rewrote by hand, which no set of censored words can
   * reproduce. Flagged rather than migrated: the next save recomputes it from the
   * original, and the admin is told before it happens.
   *
   * @returns {boolean}
   */
  get handEdited() {
    return readCensorship(this.originalText, this.text) === null;
  }

  /**
   * 20260903 ** RG #handle_censor_only
   * The handle can be blacked out but no longer edited or blanked. It is the author's
   * own name: an admin rewriting it would be publishing an attribution nobody chose,
   * and blanking it used to burn a fresh Doe#NNN on every pass. The verbatim value
   * stays in the row, so the toggle goes both ways.
   *
   * @param {boolean} censored
   */
  setHandleCensored(censored) {
    this.handleCensored = Boolean(censored);
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
