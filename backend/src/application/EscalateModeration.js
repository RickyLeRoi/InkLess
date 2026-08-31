// backend/src/application/EscalateModeration.js

import { ModerationVerdict } from '../ports/ModerationPort.js';

const LLM_FAILURE_PREFIX = 'llm_failed:';

/**
 * Hands the pending queue to the model once it has grown past the threshold.
 *
 * The model is slow and the Pi has one of it, so this is deliberately not part of
 * the submission path: a message is judged by the regex stage immediately, and only
 * the accumulated leftovers are escalated in one batch.
 */
export class EscalateModeration {
  /**
   * @param {object} deps
   * @param {import('../ports/MessageRepository.js').MessageRepository} deps.messages
   * @param {import('../ports/ModerationPort.js').LlmModerationPort} deps.llm
   * @param {number} deps.threshold queue depth that triggers a run
   * @param {number} deps.batchSize ceiling on one run
   */
  constructor({ messages, llm, threshold, batchSize }) {
    this.messages = messages;
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

    const summary = { ran: true, examined: 0, approved: 0, rejected: 0, keptForHuman: 0, retryable: 0 };

    try {
      if (!(await this.llm.isAvailable())) {
        return { ran: false, reason: 'llm_unavailable' };
      }

      const batch = await this.messages.findAwaitingLlm(this.batchSize);

      // Sequential on purpose: the model runs on the RPi alongside the printer, and
      // parallel requests there buy latency rather than throughput.
      for (const message of batch) {
        const result = await this.llm.evaluate(message.text);
        summary.examined += 1;

        if (result.reasons.some((reason) => reason.startsWith(LLM_FAILURE_PREFIX))) {
          // The model never actually judged this one. Leaving the flag unset is what
          // lets the next batch pick it up again instead of parking it on the admin.
          summary.retryable += 1;
          continue;
        }

        if (result.verdict === ModerationVerdict.AUTO_APPROVE) {
          message.approve();
          summary.approved += 1;
        } else if (result.verdict === ModerationVerdict.REJECT) {
          message.reject();
          summary.rejected += 1;
        } else {
          summary.keptForHuman += 1;
        }

        message.recordModeration([...message.moderationReasons, ...result.reasons]);
        message.markLlmReviewed();
        await this.messages.save(message);
      }
    } finally {
      this.running = false;
    }

    return summary;
  }
}
