// backend/src/ports/ModerationPort.js

export const ModerationVerdict = Object.freeze({
  AUTO_APPROVE: 'auto_approve',
  NEEDS_REVIEW: 'needs_review',
  REJECT: 'reject'
});

/** @typedef {'auto_approve' | 'needs_review' | 'reject'} ModerationVerdictValue */

/** Higher wins when two judgements disagree. */
const SEVERITY = Object.freeze({
  auto_approve: 0,
  needs_review: 1,
  reject: 2
});

/**
 * Combines independent judgements — message body and author handle, say — into the
 * strictest of them, merging the reasons so the admin sees what fired.
 *
 * @param {...import('./ModerationPort.js').ModerationResult} results
 * @returns {import('./ModerationPort.js').ModerationResult}
 */
export function strictestOf(...results) {
  /** @type {{ verdict: ModerationVerdictValue, reasons: string[] }} */
  let worst = { verdict: ModerationVerdict.AUTO_APPROVE, reasons: [] };

  for (const result of results) {
    if (SEVERITY[result.verdict] > SEVERITY[worst.verdict]) {
      worst = { verdict: result.verdict, reasons: [...result.reasons] };
    } else if (SEVERITY[result.verdict] === SEVERITY[worst.verdict]) {
      worst = { verdict: worst.verdict, reasons: [...worst.reasons, ...result.reasons] };
    }
  }

  return { verdict: worst.verdict, reasons: [...new Set(worst.reasons)] };
}

/**
 * @typedef {object} ModerationResult
 * @property {ModerationVerdictValue} verdict
 * @property {string[]} reasons machine-readable rule identifiers, for the admin UI
 *
 * @typedef {object} ModerationPort
 * @property {(text: string) => Promise<ModerationResult>} evaluate
 * @property {(handle: string) => Promise<ModerationResult>} evaluateHandle
 *
 * Second-opinion stage. Slower and more expensive than the regex pass, so it runs on
 * a batch once the queue justifies it rather than on every submission.
 *
 * @typedef {object} LlmModerationPort
 * @property {(text: string) => Promise<ModerationResult>} evaluate
 * @property {() => Promise<boolean>} isAvailable
 */

export {};
