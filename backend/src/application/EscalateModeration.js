// backend/src/application/EscalateModeration.js

import { ModerationVerdict } from '../ports/ModerationPort.js';

const LLM_FAILURE_PREFIX = 'llm_failed:';

/**
 * 20260903 ++ RG #llm_cannot_bin_an_ambiguous_message
 * Reasons that mean "a person decides this one". The regex stage raises them for the
 * words that are vulgar in one sentence and affectionate in the next, and a message
 * carrying one is in the queue precisely because no automatic stage should close it —
 * the model included. It may still clear such a message, which is the whole reason the
 * batch exists; it just cannot reject it.
 */
const HUMAN_ONLY_REASONS = Object.freeze(['ambiguous_language', 'handle_ambiguous']);

/**
 * 20260903 ++ RG #model_does_not_publish_personal_data
 * Reasons that are not a judgement about language: a phone number, an email, a home
 * address, a link, a wall of characters. The model reads sentences, and asked about
 * these it answers "no vulgarity, no target, safe" — which is true and beside the
 * point, because what has to be decided is whether that number belongs to the person
 * writing it. So it may leave such a message in the queue, never publish it.
 */
const NON_LINGUISTIC_REASONS = Object.freeze([
  'contact_details',
  'phone_number',
  'street_address',
  'link_spam',
  'character_flood',
  'shouting'
]);

/** Says in the admin queue why a published message came back. */
export const LLM_TAKEDOWN_REASON = 'llm_takedown';

/**
 * Hands the queue to the model once it has grown past the threshold.
 *
 * The model is slow and there is one of it, so this is deliberately not part of the
 * submission path: a message is judged by the regex stage immediately, and only the
 * accumulated leftovers are escalated in one batch.
 */
export class EscalateModeration {
  /**
   * @param {object} deps
   * @param {import('../ports/MessageRepository.js').MessageRepository} deps.messages
   * @param {import('../ports/ModerationPort.js').ModerationPort} deps.moderation the
   *   regex stage, re-run to recover the words it caught: the matches travel with the
   *   verdict and are never persisted, and they are what the model gets pointed at
   * @param {import('../ports/ModerationPort.js').LlmModerationPort} deps.llm
   * @param {number} deps.threshold queue depth that triggers a run
   * @param {number} deps.batchSize ceiling on one run
   */
  constructor({ messages, moderation, llm, threshold, batchSize }) {
    this.messages = messages;
    this.moderation = moderation;
    this.llm = llm;
    this.threshold = threshold;
    this.batchSize = batchSize;
    this.running = false;
  }

  /**
   * @returns {Promise<any>}
   */
  async runIfNeeded() {
    const pending = await this.messages.countAwaitingLlm();
    if (pending < this.threshold) {
      return { ran: false, reason: 'below_threshold', pending };
    }
    return this.run();
  }

  /**
   * @returns {Promise<any>}
   */
  async run() {
    // 20260831 ++ RG #single_batch_at_a_time
    // Submissions can fire this concurrently, and two overlapping runs would send the
    // same messages to the model twice: the reviewed flag is only written at the end
    // of each message's turn.
    if (this.running) return { ran: false, reason: 'already_running' };

    // The flag must go up before the first await. Setting it after one lets a second
    // caller slip past the guard while this one is suspended, which is precisely the
    // double-send the flag exists to prevent.
    this.running = true;

    const summary = {
      ran: true,
      examined: 0,
      approved: 0,
      rejected: 0,
      recalled: 0,
      keptForHuman: 0,
      retryable: 0
    };

    try {
      if (!(await this.llm.isAvailable())) {
        return { ran: false, reason: 'llm_unavailable' };
      }

      const batch = await this.messages.findAwaitingLlm(this.batchSize);

      // Sequential on purpose: one model serves this box, and parallel requests there
      // buy latency rather than throughput.
      for (const message of batch) {
        const context = await this.#contextFor(message);
        const result = await this.llm.evaluate(message.text, context);
        summary.examined += 1;

        if (result.reasons.some((reason) => reason.startsWith(LLM_FAILURE_PREFIX))) {
          // The model never actually judged this one. Leaving the flag unset is what
          // lets the next batch pick it up again instead of parking it on the admin.
          summary.retryable += 1;
          continue;
        }

        const reasons = [...message.moderationReasons, ...result.reasons];
        this.#applyVerdict(message, result.verdict, context, summary, reasons);

        message.recordModeration(reasons);
        message.markLlmReviewed();
        await this.messages.save(message);
      }
    } finally {
      this.running = false;
    }

    return summary;
  }

  /**
   * @param {import('../domain/Message.js').Message} message
   * @param {import('../ports/ModerationPort.js').ModerationVerdictValue} verdict
   * @param {{ reasons: string[], matches: string[] }} context
   * @param {{ approved: number, rejected: number, recalled: number, keptForHuman: number }} summary
   * @param {string[]} reasons collected so far, appended to when the message is recalled
   */
  #applyVerdict(message, verdict, context, summary, reasons) {
    const published = message.isPublished;

    if (verdict === ModerationVerdict.AUTO_APPROVE) {
      // Already on the board: the audit pass agreeing with the regex changes nothing
      // except the reviewed stamp, and approve() on an approved message would throw.
      if (published) return;

      if (this.#reasonsFor(message, context).some((r) => NON_LINGUISTIC_REASONS.includes(r))) {
        summary.keptForHuman += 1;
        return;
      }

      message.approve();
      summary.approved += 1;
      return;
    }

    if (verdict === ModerationVerdict.REJECT) {
      if (this.#humanOnly(message, context)) {
        summary.keptForHuman += 1;
        return;
      }
      if (published) {
        message.recallForReview();
        reasons.push(LLM_TAKEDOWN_REASON);
        summary.recalled += 1;
        return;
      }
      message.reject();
      summary.rejected += 1;
      return;
    }

    summary.keptForHuman += 1;
  }

  /**
   * @param {import('../domain/Message.js').Message} message
   * @param {{ reasons: string[] }} context
   * @returns {boolean}
   */
  #humanOnly(message, context) {
    return this.#reasonsFor(message, context).some((reason) => HUMAN_ONLY_REASONS.includes(reason));
  }

  /**
   * Both sets: the fresh pass covers the body under today's lists, the stored one
   * carries what the handle contributed at submission.
   *
   * @param {import('../domain/Message.js').Message} message
   * @param {{ reasons: string[] }} context
   * @returns {string[]}
   */
  #reasonsFor(message, context) {
    return [...context.reasons, ...message.moderationReasons];
  }

  /**
   * @param {import('../domain/Message.js').Message} message
   * @returns {Promise<{ reasons: string[], matches: string[] }>}
   */
  async #contextFor(message) {
    const result = await this.moderation.evaluate(message.text);
    return { reasons: result.reasons, matches: result.matches ?? [] };
  }
}
