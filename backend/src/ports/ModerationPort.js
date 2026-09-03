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
 * The matched fragments travel with the reasons: a judgement that loses the tie also
 * loses its matches, because showing what a discarded rule found would explain the
 * message with a rule that did not decide anything.
 *
 * @param {...import('./ModerationPort.js').ModerationResult} results
 * @returns {import('./ModerationPort.js').ModerationResult}
 */
export function strictestOf(...results) {
  /** @type {{ verdict: ModerationVerdictValue, reasons: string[], matches: string[] }} */
  let worst = { verdict: ModerationVerdict.AUTO_APPROVE, reasons: [], matches: [] };

  for (const result of results) {
    const matches = result.matches ?? [];
    if (SEVERITY[result.verdict] > SEVERITY[worst.verdict]) {
      worst = { verdict: result.verdict, reasons: [...result.reasons], matches: [...matches] };
    } else if (SEVERITY[result.verdict] === SEVERITY[worst.verdict]) {
      worst = {
        verdict: worst.verdict,
        reasons: [...worst.reasons, ...result.reasons],
        matches: [...worst.matches, ...matches]
      };
    }
  }

  return {
    verdict: worst.verdict,
    reasons: [...new Set(worst.reasons)],
    matches: [...new Set(worst.matches)]
  };
}

/**
 * @typedef {object} ModerationResult
 * @property {ModerationVerdictValue} verdict
 * @property {string[]} reasons machine-readable rule identifiers, for the admin UI
 * @property {string[]} [matches] the fragments that fired, spelled as the author
 *   wrote them — shown back to the submitter, never persisted
 *
 * @typedef {object} ModerationPort
 * @property {(text: string) => Promise<ModerationResult>} evaluate
 * @property {(handle: string) => Promise<ModerationResult>} evaluateHandle
 *
 * Second-opinion stage. Slower and more expensive than the regex pass, so it runs on
 * a batch once the queue justifies it rather than on every submission.
 *
 * @typedef {object} LlmModerationPort
 * @property {(text: string, context?: { reasons?: string[], matches?: string[] }) => Promise<ModerationResult>} evaluate
 * @property {() => Promise<boolean>} isAvailable
 */

export {};
