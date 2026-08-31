// backend/src/domain/identity.js

import { ValidationError } from './errors.js';

const ANONYMOUS_PREFIX = 'Doe';
const ANONYMOUS_PAD = 3;

/**
 * @param {number} sequence
 * @returns {string}
 */
export function formatAnonymousAuthor(sequence) {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new ValidationError('Anonymous sequence must be a positive integer');
  }
  return `${ANONYMOUS_PREFIX}#${String(sequence).padStart(ANONYMOUS_PAD, '0')}`;
}

/**
 * Display name for an author, whichever identity they ended up with.
 *
 * @param {{ instagramHandle: string | null, anonymousSequence: number | null }} author
 * @returns {string}
 */
export function formatAuthor(author) {
  if (author.instagramHandle) return `@${author.instagramHandle}`;
  if (author.anonymousSequence !== null) return formatAnonymousAuthor(author.anonymousSequence);
  throw new ValidationError('Author has neither a handle nor an anonymous sequence');
}

/**
 * Attribution line printed on the receipt and shown on the board.
 *
 * @param {string} author
 * @param {string | null} printer
 * @returns {string}
 */
export function formatAttribution(author, printer) {
  if (!printer || printer === author) {
    return `Scritto e stampato da: ${author}`;
  }
  return `Scritto da: ${author} - Stampato da: ${printer}`;
}
