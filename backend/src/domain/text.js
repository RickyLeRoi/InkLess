// backend/src/domain/text.js

import { ValidationError } from './errors.js';

export const MESSAGE_MAX_LENGTH = 200;
export const INSTAGRAM_HANDLE_MAX_LENGTH = 30;

const TAG_LIKE = /<[^>]*>/g;
const HORIZONTAL_WHITESPACE_RUN = /[^\S\n]{2,}/g;
const NEWLINE_RUN = /\n{3,}/g;
const INSTAGRAM_HANDLE = /^[A-Za-z0-9._]+$/;

const DELETE_CODE_POINT = 0x7f;
const FIRST_PRINTABLE_CODE_POINT = 0x20;

/**
 * Drops C0 control characters and DEL, keeping newlines and turning tabs into spaces.
 *
 * @param {string} value
 * @returns {string}
 */
function stripControlCharacters(value) {
  let output = '';
  for (const char of value) {
    if (char === '\n') {
      output += char;
      continue;
    }
    if (char === '\t') {
      output += ' ';
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code < FIRST_PRINTABLE_CODE_POINT || code === DELETE_CODE_POINT) continue;
    output += char;
  }
  return output;
}

/**
 * Strips markup and control characters, then normalises whitespace.
 *
 * 20260830 ++ RG #input_sanitization
 * Tag-like sequences are removed server-side even though React escapes on render:
 * the same text also reaches the ESC/POS printer and the video overlay, neither of
 * which has any notion of HTML escaping. A bare "<" survives on purpose — stripping
 * it would mangle honest text like "3 < 5".
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeMessageText(raw) {
  if (typeof raw !== 'string') {
    throw new ValidationError('Message text must be a string');
  }

  const cleaned = stripControlCharacters(raw.replace(TAG_LIKE, ''))
    .replace(HORIZONTAL_WHITESPACE_RUN, ' ')
    .replace(NEWLINE_RUN, '\n\n')
    .trim();

  if (cleaned.length === 0) {
    throw new ValidationError('Message text cannot be empty');
  }
  if (cleaned.length > MESSAGE_MAX_LENGTH) {
    throw new ValidationError(`Message text exceeds ${MESSAGE_MAX_LENGTH} characters`);
  }

  return cleaned;
}

/**
 * Accepts an Instagram handle with or without the leading "@".
 * Returns null for absent input, so callers can fall back to a generated identity.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeInstagramHandle(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new ValidationError('Instagram handle must be a string');
  }

  const handle = raw.trim().replace(/^@+/, '');
  if (handle.length === 0) return null;

  if (handle.length > INSTAGRAM_HANDLE_MAX_LENGTH) {
    throw new ValidationError(
      `Instagram handle exceeds ${INSTAGRAM_HANDLE_MAX_LENGTH} characters`
    );
  }
  if (!INSTAGRAM_HANDLE.test(handle)) {
    throw new ValidationError('Instagram handle contains unsupported characters');
  }
  if (handle.startsWith('.') || handle.endsWith('.') || handle.includes('..')) {
    throw new ValidationError('Instagram handle has a malformed dot sequence');
  }

  return handle;
}
