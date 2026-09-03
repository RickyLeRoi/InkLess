// backend/src/adapters/moderation/llmProtocol.js

import { ModerationVerdict } from '../../ports/ModerationPort.js';

export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * 20260903 ** RG #reasoning_before_verdict
 * The reasoning is generated BEFORE the verdict, and that ordering is the whole point
 * of this rewrite. With the verdict first, a small model picks it on the strength of
 * one alarming token and then writes a justification that agrees with itself: that is
 * how "che bel finocchio che mi hai venduto" came back as a homophobic slur. Made to
 * spell out the context first, the verdict is sampled with that context already in
 * the window. Never reorder these two keys.
 */
export const SYSTEM_PROMPT = `You are moderating an Italian public message board. Messages are
short, anonymous, and get printed on paper receipts. Expect dedications, birthday wishes,
football banter, dialect and friendly insults between people who like each other.

Classify the Italian message as "safe", "unsafe" or "unsure".

RULES
1. Judge the whole sentence, never a single word. Many Italian words are vulgar in one
   sentence and ordinary in the next, and the surrounding words decide which.
2. "unsafe" needs a target: a person or a group being insulted, threatened, sexually
   harassed or hated. Blasphemy, explicit sex, defamation, someone else's personal data
   and commercial spam are unsafe too.
3. Vulgarity with no target is not unsafe. Complaints, exclamations and self-deprecation
   are safe.
4. A threat is unsafe even when it contains no vulgar word at all.
5. Friendly insults are normal here. If you cannot tell banter from an attack, answer
   "unsure".
6. "unsure" is the safety valve: a human reads those. Never answer "unsafe" when what you
   mean is "I am not sure".

Write the reasoning FIRST, then the verdict. The reasoning must name the target, or state
that there is none.

Answer with JSON only: {"reasoning":"<max 15 words, English>","verdict":"safe|unsafe|unsure"}

EXAMPLES
Message: "il finocchio selvatico rende buonissimo l'arrosto"
{"reasoning":"Recipe context, fennel is the vegetable. No target.","verdict":"safe"}

Message: "tu e tuo fratello siete due handicappati"
{"reasoning":"Ableist insult aimed at two specific people.","verdict":"unsafe"}

Message: "sei il mio stronzo preferito"
{"reasoning":"Vulgar word used affectionately, could be banter or an attack.","verdict":"unsure"}

Message: "so dove lavori e passo a trovarti"
{"reasoning":"No vulgar word, but intimidates a specific person.","verdict":"unsure"}

Message: "grazie di tutto zia, sei speciale"
{"reasoning":"Plain dedication, nothing offensive.","verdict":"safe"}`;

/**
 * The same contract as a JSON Schema, for the runtimes that can constrain decoding to
 * it. Property order is part of the payload: Ollama compiles this into a grammar in the
 * order the keys appear, which is what nails the reasoning down in front of the verdict.
 */
export const RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    reasoning: { type: 'string' },
    verdict: { type: 'string', enum: ['safe', 'unsafe', 'unsure'] }
  },
  required: ['reasoning', 'verdict']
});

/**
 * 20260903 ++ RG #regex_context_to_the_model
 * The model used to arrive blind: it was handed a message and no hint that the regex
 * stage had already parked it over one specific word. Naming that word turns an open
 * question ("is this message acceptable?") into a closed one a small model can answer
 * ("is this word literal, affectionate, or an attack?").
 *
 * Only the ambiguous flags produce a hint. A phone number or a link is not a word
 * whose meaning the model has to weigh, and pointing at one would just add noise.
 *
 * @param {string} text
 * @param {{ reasons?: string[], matches?: string[] }} [context]
 * @returns {string}
 */
export function buildUserMessage(text, context = {}) {
  const ambiguous = (context.reasons ?? []).some((reason) => reason.endsWith('ambiguous_language') || reason === 'handle_ambiguous');
  const words = (context.matches ?? []).slice(0, 3);
  // The same shape as the few-shot examples: a model that has just read five turns
  // starting with "Message:" should get a sixth that looks like them.
  if (!ambiguous || words.length === 0) return `Message: "${text}"`;

  const quoted = words.map((word) => `"${word}"`).join(', ');
  const subject = words.length === 1 ? `the word ${quoted} is` : `the words ${quoted} are`;
  return (
    `Message: "${text}"\n[Automatic filter: ${subject} on the ambiguous list. Decide from ` +
    'this sentence alone whether it is used literally, affectionately, or as an attack ' +
    'on someone.]'
  );
}

/** Enough of the model's reasoning to be worth reading in the admin panel. */
const REASON_MAX_LENGTH = 80;

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
 * 20260903 ** RG #reasoning_before_verdict
 * "reason" is still read as a fallback: the endpoint behind the OpenAI adapter is a
 * gateway that rotates between providers and models, and one answering in the old shape
 * is worth a verdict rather than a retry loop.
 *
 * @param {any} parsed
 * @returns {string}
 */
function readReason(parsed) {
  for (const key of ['reasoning', 'reason']) {
    const value = parsed?.[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, REASON_MAX_LENGTH);
  }
  return 'llm';
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

  return { verdict, reasons: [`llm:${readReason(parsed)}`] };
}

/**
 * @param {unknown} error
 * @returns {import('../../ports/ModerationPort.js').ModerationResult}
 */
export function describeFailure(error) {
  if (error instanceof Error && error.name === 'TimeoutError') return undecided('timeout');
  return undecided('unreachable');
}
