// backend/src/domain/censor.js

import { ValidationError } from './errors.js';

/**
 * 20260903 ++ RG #word_censorship
 * The admin blacks out words, never rewrites them. Every function here works from the
 * verbatim submission, so the published text is always a pure function of
 * (original_text, set of censored indices) — which is what makes the toggle reversible
 * without persisting the set anywhere: the mask keeps the exact length of the word, so
 * the indices can be read back out of the published text.
 */

const WORD = /[\p{L}\p{N}]+/gu;

/**
 * Below this there is no interior to hide: the first and last letter stay in the clear
 * by definition, so a two-letter word would come out of the mask unchanged and the
 * toggle would appear to switch itself off on the next read.
 */
export const MIN_CENSORABLE_LENGTH = 3;

/**
 * @typedef {object} Word
 * @property {number} index position in the sentence, the id the admin toggles
 * @property {number} start offset in the original text
 * @property {number} end offset in the original text, exclusive
 * @property {string} word
 * @property {boolean} censorable
 */

/**
 * Splits into maskable cores. Punctuation and apostrophes stay separators, so
 * "cazzo!" masks to "c***o!" and "dell'idiota" to "dell'i****a".
 *
 * @param {string} text
 * @returns {Word[]}
 */
export function tokenizeWords(text) {
  /** @type {Word[]} */
  const words = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    const start = match.index ?? 0;
    words.push({
      index: words.length,
      start,
      end: start + word.length,
      word,
      censorable: [...word].length >= MIN_CENSORABLE_LENGTH
    });
  }
  return words;
}

/**
 * First and last character in the clear, the rest starred. The result keeps the exact
 * code-unit length of the input, which the whole derivation below depends on.
 *
 * @param {string} word
 * @returns {string}
 */
export function maskWord(word) {
  const chars = [...word];
  if (chars.length < MIN_CENSORABLE_LENGTH) return word;

  const first = chars[0];
  const last = chars[chars.length - 1];
  return `${first}${'*'.repeat(word.length - first.length - last.length)}${last}`;
}

/**
 * @param {string} originalText
 * @param {Iterable<number>} indices
 * @returns {string}
 */
export function applyCensorship(originalText, indices) {
  const wanted = new Set(indices);

  let output = '';
  let cursor = 0;
  for (const word of tokenizeWords(originalText)) {
    if (!wanted.has(word.index) || !word.censorable) continue;
    output += originalText.slice(cursor, word.start) + maskWord(word.word);
    cursor = word.end;
  }

  return output + originalText.slice(cursor);
}

/**
 * The inverse: which words are blacked out in a published text.
 *
 * @param {string} originalText
 * @param {string} text
 * @returns {number[] | null} null when the published text cannot have come from a
 *   censorship at all — a body rewritten by hand through the old free-text panel
 */
export function readCensorship(originalText, text) {
  if (text.length !== originalText.length) return null;

  /** @type {number[]} */
  const censored = [];
  for (const word of tokenizeWords(originalText)) {
    const slice = text.slice(word.start, word.end);
    if (slice === word.word) continue;
    if (word.censorable && slice === maskWord(word.word)) {
      censored.push(word.index);
      continue;
    }
    return null;
  }

  // Rebuilding and comparing also covers the separators, which the loop above skips.
  return applyCensorship(originalText, censored) === text ? censored : null;
}

/**
 * What the moderation panel draws: every word with its own toggle state.
 *
 * Offsets travel with the words so the panel can lay the sentence back out exactly as
 * it was written — punctuation and spacing included — with only the words clickable.
 *
 * @param {string} originalText
 * @param {string} text
 * @returns {Array<{ index: number, start: number, end: number, word: string, censored: boolean, censorable: boolean }>}
 */
export function describeWords(originalText, text) {
  const censored = new Set(readCensorship(originalText, text) ?? []);
  return tokenizeWords(originalText).map((word) => ({
    index: word.index,
    start: word.start,
    end: word.end,
    word: word.word,
    censored: censored.has(word.index),
    censorable: word.censorable
  }));
}

/**
 * @param {unknown} indices
 * @returns {number[]}
 */
export function normalizeWordIndices(indices) {
  if (!Array.isArray(indices)) {
    throw new ValidationError('Censored words must be an array of indices');
  }
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0) {
      throw new ValidationError('A censored word index must be a non-negative integer');
    }
  }
  return [...new Set(/** @type {number[]} */ (indices))].sort((a, b) => a - b);
}
