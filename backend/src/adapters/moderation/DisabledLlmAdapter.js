// backend/src/adapters/moderation/DisabledLlmAdapter.js

import { ModerationVerdict } from '../../ports/ModerationPort.js';

/**
 * Stands in when no model is configured. Reports itself unavailable so the
 * escalation use case skips the batch instead of marking anything reviewed.
 *
 * Satisfies the LlmModerationPort contract.
 */
export class DisabledLlmAdapter {
  /** @returns {Promise<boolean>} */
  async isAvailable() {
    return false;
  }

  /**
   * @returns {Promise<import('../../ports/ModerationPort.js').ModerationResult>}
   */
  async evaluate() {
    return { verdict: ModerationVerdict.NEEDS_REVIEW, reasons: ['llm_failed:disabled'] };
  }
}
