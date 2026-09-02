// frontend/src/lib/censor.js

/**
 * 20260903 ++ RG #word_censorship
 * The preview of a blacked-out word, so a click shows the result instead of a colour
 * change. Deliberately the only piece of the censorship that lives here: the words,
 * their indices and their toggle state all arrive from the server, which stays the
 * authority on what actually gets published.
 *
 * @param {string} word
 * @returns {string}
 */
export function maskWord(word) {
  const chars = [...word];
  if (chars.length < 3) return word;
  return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}
