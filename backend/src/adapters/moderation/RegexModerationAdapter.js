// backend/src/adapters/moderation/RegexModerationAdapter.js

import { ModerationVerdict } from '../../ports/ModerationPort.js';
import { INSTAGRAM_HANDLE_MAX_LENGTH, MESSAGE_MAX_LENGTH } from '../../domain/text.js';
import {
  BLASPHEMY,
  HARD_REJECT,
  PROFANITY,
  SUSPICIOUS,
  SUSPICIOUS_PAIRS
} from './blocklist.js';

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

const URL_LIKE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|it|io|xyz|ru|top|link)\b)/gi;
const EMAIL_LIKE = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi;
const PHONE_LIKE = /(?:\+?\d[\s.-]?){8,}/g;
/**
 * 20260903 ++ RG #street_address
 * Where somebody lives or works, which is personal data whoever wrote it. A street
 * word, a name and a house number: the number is what makes it an address rather than
 * a mention, so "ci vediamo in via Roma" stays clean and "abita in via Roma 4" does
 * not. Pattern work, not language work — which is why it belongs here and the model is
 * told to leave it alone.
 */
const ADDRESS_LIKE =
  /\b(?:via|viale|piazza|piazzale|corso|vicolo|largo|strada|contrada)\s+[\p{L}'’.-]+(?:\s+[\p{L}'’.-]+)?[,\s]+\d{1,4}\b/giu;
const CHAR_FLOOD = /(.)\1{5,}/g;
const SHOUTING_MIN_LENGTH = 20;
const SHOUTING_RATIO = 0.7;

/** How much junk may sit between two letters of a blocked word: "c.a.z.z.o". */
const SEPARATOR = '[^\\p{L}\\p{N}]{0,2}';
/** How much may sit between the two halves of a compositional insult: "porco dio". */
const GAP = '[^\\p{L}\\p{N}]{0,3}';
/**
 * 20260903 ++ RG #ordered_pairs
 * The looser gap the ordered pairs need: up to two short words between the halves, so
 * "spacco la faccia" and "ti spacco quella faccia" both land while the two words stay
 * in the same clause. Anything longer than four letters ends the match, which is what
 * keeps a pair from spanning half the message.
 */
const WORD_GAP = '[^\\p{L}\\p{N}]{1,3}(?:\\p{L}{1,4}[^\\p{L}\\p{N}]{1,3}){0,2}';

/** Enough to show the author what tripped the filter without printing a wall. */
const MAX_REPORTED_MATCHES = 8;

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

/**
 * 20260902 ++ RG #report_the_dictionary_word
 * What a matcher found, named by the blocklist entry rather than by the characters
 * on the page: "c4zz0" comes back as "cazzo". The author knows what they wrote — the
 * useful half of the answer is which word we bin, and the plain spelling says that
 * without also handing over a map of which disguises the filter can and cannot see.
 *
 * @param {Lexicon} lexicon
 * @param {string} haystack
 * @returns {string[]}
 */
function lexiconHits(lexicon, haystack) {
  /** @type {string[]} */
  const found = [];

  for (const match of haystack.matchAll(lexicon.regex)) {
    // One capture group per entry, so the group that fired names the word.
    const index = match.slice(1).findIndex((group) => group !== undefined);
    if (index >= 0) found.push(lexicon.words[index]);
  }
  return found;
}

/**
 * Patterns with nothing to look up behind them — a link, a phone number, a
 * compositional blasphemy — report the fragment they matched.
 *
 * @param {RegExp} matcher must carry the global flag
 * @param {string} haystack
 * @returns {string[]}
 */
function phraseHits(matcher, haystack) {
  return [...haystack.matchAll(matcher)].map((match) => match[0].trim());
}

/**
 * The squeezed pass is a fallback, not a second opinion: run on a phrase both passes
 * match, it reports the same insult with the doubles missing ("porcacio dio"), and
 * the author gets told off twice in two spellings.
 *
 * @param {RegExp} plain
 * @param {string} folded
 * @param {RegExp} squeezed
 * @param {string} squeezedText
 * @returns {string[]}
 */
function phraseHitsOrSqueezed(plain, folded, squeezed, squeezedText) {
  const hits = phraseHits(plain, folded);
  return hits.length > 0 ? hits : phraseHits(squeezed, squeezedText);
}

/** @param {string[]} values */
function unique(values) {
  return [...new Set(values.filter(Boolean))].slice(0, MAX_REPORTED_MATCHES);
}

/** @param {string} word */
function escapeRegex(word) {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A blocklist compiled into one matcher, plus the entries it can report.
 *
 * @typedef {{ regex: RegExp, words: readonly string[] }} Lexicon
 */

/**
 * Builds a word-bounded matcher that tolerates separators between letters.
 *
 * @param {readonly string[]} patterns spellings to look for
 * @param {readonly string[]} [reported] what to call them, index by index; defaults
 *   to the patterns themselves. The squeezed matcher searches for "cazo" and still
 *   reports "cazzo".
 * @returns {Lexicon}
 */
function buildWordMatcher(patterns, reported = patterns) {
  const alternatives = patterns.map((word) => `(${[...escapeRegex(word)].join(SEPARATOR)})`);
  return {
    regex: new RegExp(`(?<!\\p{L})(?:${alternatives.join('|')})(?!\\p{L})`, 'giu'),
    words: reported
  };
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
 * @returns {Lexicon}
 */
function buildSubstringMatcher(words) {
  const alternatives = words.map((word) => `(${[...escapeRegex(word)].join(SEPARATOR)})`);
  return { regex: new RegExp(`(?:${alternatives.join('|')})`, 'giu'), words };
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
    'giu'
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
  // 20260903 ** RG #truncated_epithets
  // The ending is optional, or "dio can" walks past a matcher that catches "dio cane"
  // — and the truncated form is the one Veneto actually says. No stem on the list is
  // an Italian word on its own, and the pair still has to sit next to a deity, so
  // widening this end costs nothing.
  const ending = `${transform(BLASPHEMY.epithetEnding)}?`;
  return BLASPHEMY.epithetStems.map((stem) => `${escapeRegex(transform(stem))}${ending}`).join('|');
}

/**
 * Builds the matcher for an ordered pair: left half, a short gap, right half. Not
 * buildPairMatcher: that one accepts either order, which here would turn "lo scopo ti
 * riguarda" into a proposition.
 *
 * @param {readonly string[]} pair
 * @returns {RegExp}
 */
function buildOrderedPairMatcher(pair) {
  const [left, right] = pair.map((word) => [...escapeRegex(word)].join(SEPARATOR));
  return new RegExp(`(?<!\\p{L})${left}${WORD_GAP}${right}(?!\\p{L})`, 'giu');
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

    this.suspiciousPairs = SUSPICIOUS_PAIRS.map(buildOrderedPairMatcher);

    this.handleMatchers = {
      hate: buildSubstringMatcher(HARD_REJECT),
      profanity: buildSubstringMatcher(PROFANITY),
      suspicious: buildSubstringMatcher(SUSPICIOUS)
    };
    this.handleBlasphemy = new RegExp(
      `(?:${alternationOf(BLASPHEMY.deities)})(?:${epithetAlternation()})` +
        `|(?:${epithetAlternation()})(?:${alternationOf(BLASPHEMY.deities)})`,
      'giu'
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
      return { verdict: ModerationVerdict.NEEDS_REVIEW, reasons: ['handle_oversized'], matches: [] };
    }

    const folded = fold(handle);
    const squeezed = squeezeRuns(folded);

    /** @type {string[]} */
    const reasons = [];
    /** @type {string[]} */
    const matches = [];

    /**
     * @param {string[]} hits
     * @param {string} reason
     */
    const check = (hits, reason) => {
      if (hits.length === 0) return;
      reasons.push(reason);
      matches.push(...hits);
    };

    /** @param {Lexicon} lexicon */
    const words = (lexicon) => [...lexiconHits(lexicon, folded), ...lexiconHits(lexicon, squeezed)];

    check(words(this.handleMatchers.hate), 'handle_hate_speech');
    check(
      phraseHitsOrSqueezed(this.handleBlasphemy, folded, this.handleBlasphemy, squeezed),
      'handle_blasphemy'
    );
    check(words(this.handleMatchers.profanity), 'handle_profanity');
    check(words(this.handleMatchers.suspicious), 'handle_ambiguous');

    if (reasons.length === 0) {
      return { verdict: ModerationVerdict.AUTO_APPROVE, reasons: [], matches: [] };
    }
    return { verdict: ModerationVerdict.NEEDS_REVIEW, reasons, matches: unique(matches) };
  }

  /**
   * @param {string} text
   * @returns {Promise<import('../../ports/ModerationPort.js').ModerationResult>}
   */
  async evaluate(text) {
    if (!withinBounds(text, MESSAGE_MAX_LENGTH)) {
      return { verdict: ModerationVerdict.NEEDS_REVIEW, reasons: ['oversized'], matches: [] };
    }

    const folded = fold(text);
    const squeezed = squeezeRuns(folded);

    /** @param {{ plain: Lexicon, squeezed: Lexicon }} pair */
    const wordHits = (pair) => [
      ...lexiconHits(pair.plain, folded),
      ...lexiconHits(pair.squeezed, squeezed)
    ];

    const hate = wordHits(this.matchers.hate);
    if (hate.length > 0) {
      return { verdict: ModerationVerdict.REJECT, reasons: ['hate_speech'], matches: unique(hate) };
    }

    // No dictionary entry behind these — the offending pair is the two halves the
    // author put next to each other, folded back to their plain spelling.
    const blasphemy = phraseHitsOrSqueezed(this.blasphemy, folded, this.blasphemySqueezed, squeezed);
    if (blasphemy.length > 0) {
      return {
        verdict: ModerationVerdict.REJECT,
        reasons: ['blasphemy'],
        matches: unique(blasphemy)
      };
    }

    const profanity = wordHits(this.matchers.profanity);
    if (profanity.length > 0) {
      return {
        verdict: ModerationVerdict.REJECT,
        reasons: ['profanity'],
        matches: unique(profanity)
      };
    }

    // 20260830 ** RG #email_misread_as_link
    // The domain half of an address matches URL_LIKE, so emails are masked out first:
    // leaving a contact detail for a human to judge beats auto-rejecting it as spam.
    const withoutEmails = text.replace(EMAIL_LIKE, ' ');
    /** @type {string[]} */
    const doubts = [];
    /** @type {string[]} */
    const matches = [];

    /**
     * @param {string[]} hits
     * @param {string} reason
     */
    const suspect = (hits, reason) => {
      if (hits.length === 0) return;
      doubts.push(reason);
      matches.push(...hits);
    };

    suspect(wordHits(this.matchers.suspicious), 'ambiguous_language');
    suspect(
      this.suspiciousPairs.flatMap((matcher) => phraseHits(matcher, folded)),
      'ambiguous_language'
    );
    // 20260903 ** RG #link_is_not_spam_by_itself
    // Demoted from rejection to review: this board is built around Instagram handles,
    // and the link in the body is what somebody writes when they have not found the
    // field for it. The spammer still gets stopped, by a person.
    suspect(phraseHits(URL_LIKE, withoutEmails), 'link_spam');
    suspect(phraseHits(EMAIL_LIKE, text), 'contact_details');
    suspect(phraseHits(PHONE_LIKE, text), 'phone_number');
    suspect(phraseHits(ADDRESS_LIKE, text), 'street_address');
    suspect(phraseHits(CHAR_FLOOD, text), 'character_flood');
    if (isShouting(text)) doubts.push('shouting');

    if (doubts.length > 0) {
      // The words and the ordered pairs answer to the same reason, so a message
      // carrying both must not tell the admin about it twice.
      return {
        verdict: ModerationVerdict.NEEDS_REVIEW,
        reasons: [...new Set(doubts)],
        matches: unique(matches)
      };
    }
    return { verdict: ModerationVerdict.AUTO_APPROVE, reasons: [], matches: [] };
  }
}

/**
 * @param {readonly string[]} words
 * @returns {{ plain: Lexicon, squeezed: Lexicon }}
 */
function buildMatcherPair(words) {
  // The squeezed alternation is not deduplicated: its entries have to line up with
  // the plain list index for index, or a match would report the wrong word.
  return {
    plain: buildWordMatcher(words),
    squeezed: buildWordMatcher(words.map(squeezeRuns), words)
  };
}
