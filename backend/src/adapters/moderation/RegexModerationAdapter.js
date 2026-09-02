// backend/src/adapters/moderation/RegexModerationAdapter.js

import { ModerationVerdict } from '../../ports/ModerationPort.js';
import { INSTAGRAM_HANDLE_MAX_LENGTH, MESSAGE_MAX_LENGTH } from '../../domain/text.js';
import { BLASPHEMY, HARD_REJECT, PROFANITY, SUSPICIOUS } from './blocklist.js';

/** @type {Readonly<Record<string, string>>} */
const LEET_MAP = Object.freeze({
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '9': 'g',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
  '+': 't'
});

/**
 * 20260831 ++ RG #homoglyph_folding
 * Cyrillic and Greek letters that are visually identical to Latin ones. Unicode
 * normalisation will never fold these — they are distinct letters, not decorated
 * variants — so "tеrrone" with a Cyrillic "е" walked straight past every other
 * layer. One paste from a homoglyph generator was enough to defeat the filter.
 *
 * @type {Readonly<Record<string, string>>}
 */
const HOMOGLYPH_MAP = Object.freeze({
  // Cyrillic
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p',
  с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd',
  // Greek
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p',
  τ: 't', υ: 'u', χ: 'x', γ: 'y'
});

const URL_LIKE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|it|io|xyz|ru|top|link)\b)/i;
const EMAIL_LIKE = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i;
const EMAIL_LIKE_GLOBAL = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi;
const PHONE_LIKE = /(?:\+?\d[\s.-]?){8,}/;
const CHAR_FLOOD = /(.)\1{5,}/;
const SHOUTING_MIN_LENGTH = 20;
const SHOUTING_RATIO = 0.7;

/** How much junk may sit between two letters of a blocked word: "c.a.z.z.o". */
const SEPARATOR = '[^\\p{L}\\p{N}]{0,2}';
/** How much may sit between the two halves of a compositional insult: "porco dio". */
const GAP = '[^\\p{L}\\p{N}]{0,3}';

/**
 * Folds accents and letter/digit substitutions onto the plain spelling, so the
 * blocklist only ever has to carry dictionary words.
 *
 * @param {string} text
 * @returns {string}
 */
function fold(text) {
  // NFKD rather than NFD: it also folds compatibility forms, so fullwidth "ｃａｚｚｏ"
  // and ligatures collapse onto plain ASCII before anything else runs.
  const stripped = text
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

  let output = '';
  for (const char of stripped) {
    output += LEET_MAP[char] ?? HOMOGLYPH_MAP[char] ?? char;
  }
  return output;
}

/**
 * 20260831 ++ RG #run_squeezing
 * Collapses runs of the same character so "caaaazzzo" and "porcoddio" reduce to the
 * same shape as the dictionary word. Applied to both sides of the comparison, which
 * is what keeps "cazzo" (squeezing to "cazo") matching itself.
 *
 * @param {string} text
 * @returns {string}
 */
function squeezeRuns(text) {
  return text.replace(/(.)\1+/gu, '$1');
}

/** @param {string} word */
function escapeRegex(word) {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a word-bounded matcher that tolerates separators between letters.
 *
 * @param {readonly string[]} words
 * @returns {RegExp}
 */
function buildWordMatcher(words) {
  const alternatives = words.map((word) =>
    [...escapeRegex(word)].join(SEPARATOR)
  );
  return new RegExp(`(?<!\\p{L})(?:${alternatives.join('|')})(?!\\p{L})`, 'iu');
}

/**
 * 20260831 ++ RG #handle_substring_matching
 * Same words, no word boundaries. An Instagram handle is a single run of characters
 * with the spaces removed, so "ilcazzone" and "dioporco90" hide the word inside a
 * token and the bounded matcher never sees them. Substring matching is too blunt for
 * free text — it would flag "cazzuola" — but on a 30-character handle the trade is
 * worth it, and the harsher verdict here is review, not rejection.
 *
 * @param {readonly string[]} words
 * @returns {RegExp}
 */
function buildSubstringMatcher(words) {
  const alternatives = words.map((word) => [...escapeRegex(word)].join(SEPARATOR));
  return new RegExp(`(?:${alternatives.join('|')})`, 'iu');
}

/**
 * Builds a matcher for two-token insults, in both orders and with any junk between.
 *
 * Both sides arrive as ready-made alternation fragments rather than word lists: the
 * epithet side carries an inflection pattern that must not be escaped.
 *
 * @param {string} left
 * @param {string} right
 * @returns {RegExp}
 */
function buildPairMatcher(left, right) {
  return new RegExp(
    `(?<!\\p{L})(?:(?:${left})${GAP}(?:${right})|(?:${right})${GAP}(?:${left}))(?!\\p{L})`,
    'iu'
  );
}

/**
 * @param {readonly string[]} words
 * @returns {string}
 */
function alternationOf(words) {
  return words.map(escapeRegex).join('|');
}

/**
 * The epithet half of a blasphemy: every stem followed by any of its endings.
 *
 * @param {(value: string) => string} [transform] applied to stems and ending alike,
 *   so the squeezed matcher stays aligned with squeezed text ("porcaccio" arrives as
 *   "porcacio", and the ending it must meet is "aci[aeio]").
 * @returns {string}
 */
function epithetAlternation(transform = (value) => value) {
  const ending = transform(BLASPHEMY.epithetEnding);
  return BLASPHEMY.epithetStems.map((stem) => `${escapeRegex(transform(stem))}${ending}`).join('|');
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isShouting(text) {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length < SHOUTING_MIN_LENGTH) return false;
  const uppercase = letters.replace(/[^\p{Lu}]/gu, '').length;
  return uppercase / letters.length >= SHOUTING_RATIO;
}

/**
 * 20260831 ++ RG #bounded_before_matching
 * Every matcher below is an alternation of dozens of words, each letter separated by
 * an optional 'junk' class, run over the whole input on the synchronous submission
 * path. Today normalizeMessageText caps the text long before it gets here, so the
 * cost is bounded — but the guarantee lives in another module, and a future caller
 * that skips it would hand this a megabyte to backtrack through.
 *
 * Refusing outright rather than truncating: scanning the first 200 characters of a
 * longer string and calling it clean is exactly how a filter gets walked past.
 *
 * @param {string} value
 * @param {number} limit
 * @returns {boolean}
 */
function withinBounds(value, limit) {
  return value.length <= limit;
}

/** Satisfies the ModerationPort contract. */
export class RegexModerationAdapter {
  constructor() {
    this.matchers = {
      hate: buildMatcherPair(HARD_REJECT),
      profanity: buildMatcherPair(PROFANITY),
      suspicious: buildMatcherPair(SUSPICIOUS)
    };
    this.blasphemy = buildPairMatcher(alternationOf(BLASPHEMY.deities), epithetAlternation());
    this.blasphemySqueezed = buildPairMatcher(
      alternationOf(BLASPHEMY.deities.map(squeezeRuns)),
      epithetAlternation(squeezeRuns)
    );

    this.handleMatchers = {
      hate: buildSubstringMatcher(HARD_REJECT),
      profanity: buildSubstringMatcher(PROFANITY),
      suspicious: buildSubstringMatcher(SUSPICIOUS)
    };
    this.handleBlasphemy = new RegExp(
      `(?:${alternationOf(BLASPHEMY.deities)})(?:${epithetAlternation()})` +
        `|(?:${epithetAlternation()})(?:${alternationOf(BLASPHEMY.deities)})`,
      'iu'
    );
  }

  /**
   * Judges an Instagram handle, which never reaches the text pipeline but is shown
   * on the board and burned onto the receipt just the same.
   *
   * 20260831 ++ RG #handle_never_rejects
   * A handle can only ever escalate to review, never to rejection, however ugly it
   * looks. Substring matching on a 30-character token is blunt enough to catch real
   * names by accident, and a handle is also the one field an admin can simply edit —
   * so the message goes to the queue and a person decides, rather than being binned
   * over what might be somebody's surname.
   *
   * @param {string} handle
   * @returns {Promise<import('../../ports/ModerationPort.js').ModerationResult>}
   */
  async evaluateHandle(handle) {
    if (!withinBounds(handle, INSTAGRAM_HANDLE_MAX_LENGTH)) {
      return { verdict: ModerationVerdict.NEEDS_REVIEW, reasons: ['handle_oversized'] };
    }

    const folded = fold(handle);
    const squeezed = squeezeRuns(folded);

    /** @param {RegExp} matcher */
    const matches = (matcher) => matcher.test(folded) || matcher.test(squeezed);

    /** @type {string[]} */
    const reasons = [];
    if (matches(this.handleMatchers.hate)) reasons.push('handle_hate_speech');
    if (matches(this.handleBlasphemy)) reasons.push('handle_blasphemy');
    if (matches(this.handleMatchers.profanity)) reasons.push('handle_profanity');
    if (matches(this.handleMatchers.suspicious)) reasons.push('handle_ambiguous');

    if (reasons.length === 0) {
      return { verdict: ModerationVerdict.AUTO_APPROVE, reasons: [] };
    }
    return { verdict: ModerationVerdict.NEEDS_REVIEW, reasons };
  }

  /**
   * @param {string} text
   * @returns {Promise<import('../../ports/ModerationPort.js').ModerationResult>}
   */
  async evaluate(text) {
    if (!withinBounds(text, MESSAGE_MAX_LENGTH)) {
      return { verdict: ModerationVerdict.NEEDS_REVIEW, reasons: ['oversized'] };
    }

    const folded = fold(text);
    const squeezed = squeezeRuns(folded);

    if (hits(this.matchers.hate, folded, squeezed)) {
      return { verdict: ModerationVerdict.REJECT, reasons: ['hate_speech'] };
    }
    if (this.blasphemy.test(folded) || this.blasphemySqueezed.test(squeezed)) {
      return { verdict: ModerationVerdict.REJECT, reasons: ['blasphemy'] };
    }
    if (hits(this.matchers.profanity, folded, squeezed)) {
      return { verdict: ModerationVerdict.REJECT, reasons: ['profanity'] };
    }

    // 20260830 ** RG #email_misread_as_link
    // The domain half of an address matches URL_LIKE, so emails are masked out first:
    // leaving a contact detail for a human to judge beats auto-rejecting it as spam.
    const withoutEmails = text.replace(EMAIL_LIKE_GLOBAL, ' ');
    if (URL_LIKE.test(withoutEmails)) {
      return { verdict: ModerationVerdict.REJECT, reasons: ['link_spam'] };
    }

    /** @type {string[]} */
    const doubts = [];
    if (hits(this.matchers.suspicious, folded, squeezed)) doubts.push('ambiguous_language');
    if (EMAIL_LIKE.test(text)) doubts.push('contact_details');
    if (PHONE_LIKE.test(text)) doubts.push('phone_number');
    if (CHAR_FLOOD.test(text)) doubts.push('character_flood');
    if (isShouting(text)) doubts.push('shouting');

    if (doubts.length > 0) {
      return { verdict: ModerationVerdict.NEEDS_REVIEW, reasons: doubts };
    }
    return { verdict: ModerationVerdict.AUTO_APPROVE, reasons: [] };
  }
}

/**
 * @param {readonly string[]} words
 * @returns {{ plain: RegExp, squeezed: RegExp }}
 */
function buildMatcherPair(words) {
  return {
    plain: buildWordMatcher(words),
    squeezed: buildWordMatcher([...new Set(words.map(squeezeRuns))])
  };
}

/**
 * @param {{ plain: RegExp, squeezed: RegExp }} matcher
 * @param {string} folded
 * @param {string} squeezed
 */
function hits(matcher, folded, squeezed) {
  return matcher.plain.test(folded) || matcher.squeezed.test(squeezed);
}
