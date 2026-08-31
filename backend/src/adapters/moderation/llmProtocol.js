// backend/src/adapters/moderation/llmProtocol.js

import { ModerationVerdict } from '../../ports/ModerationPort.js';

export const REQUEST_TIMEOUT_MS = 20_000;

export const SYSTEM_PROMPT = `Sei un moderatore di una bacheca pubblica italiana dove si lasciano
messaggi brevi, spesso affettuosi o goliardici, che verranno stampati su carta.

Classifica il messaggio in una sola di queste categorie:
- "safe": innocuo. Auguri, dediche, battute leggere, sfoghi senza insulti.
- "unsafe": insulti diretti a una persona, odio verso un gruppo, bestemmie,
  contenuti sessuali espliciti, minacce, spam commerciale, dati personali altrui.
- "unsure": qualsiasi cosa su cui hai un dubbio reale.

Nel dubbio scegli sempre "unsure": un umano rileggera' il messaggio.
Rispondi esclusivamente con JSON: {"verdict":"safe|unsafe|unsure","reason":"<3 parole>"}`;

/**
 * 20260831 ++ RG #llm_verdict_mapping
 * "unsure" maps to NEEDS_REVIEW, and so does anything unparseable, unreachable or
 * timed out. A moderation stage that fails open would publish whatever it choked on.
 *
 * @type {Readonly<Record<string, import('../../ports/ModerationPort.js').ModerationVerdictValue>>}
 */
const VERDICT_MAP = Object.freeze({
  safe: ModerationVerdict.AUTO_APPROVE,
  unsafe: ModerationVerdict.REJECT,
  unsure: ModerationVerdict.NEEDS_REVIEW
});

/**
 * A judgement the model never actually delivered. The escalation stage keys off the
 * "llm_failed:" prefix to retry these instead of parking them on the admin.
 *
 * @param {string} why
 * @returns {import('../../ports/ModerationPort.js').ModerationResult}
 */
export function undecided(why) {
  return { verdict: ModerationVerdict.NEEDS_REVIEW, reasons: [`llm_failed:${why}`] };
}

/**
 * Turns whatever the model wrote into a verdict.
 *
 * @param {unknown} content
 * @returns {import('../../ports/ModerationPort.js').ModerationResult}
 */
export function parseVerdict(content) {
  if (typeof content !== 'string' || content.trim() === '') return undecided('empty_response');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undecided('unparseable');
  }

  const verdict = VERDICT_MAP[String(parsed?.verdict).toLowerCase()];
  if (!verdict) return undecided('unknown_verdict');

  const reason = typeof parsed?.reason === 'string' ? parsed.reason.slice(0, 40) : 'llm';
  return { verdict, reasons: [`llm:${reason}`] };
}

/**
 * @param {unknown} error
 * @returns {import('../../ports/ModerationPort.js').ModerationResult}
 */
export function describeFailure(error) {
  if (error instanceof Error && error.name === 'TimeoutError') return undecided('timeout');
  return undecided('unreachable');
}
