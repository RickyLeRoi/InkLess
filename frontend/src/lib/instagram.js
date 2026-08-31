// frontend/src/lib/instagram.js

/**
 * The one place that knows how a handle becomes a URL. Both the receipt link and the
 * QR codes point at the same string, so a change here cannot leave them disagreeing.
 *
 * @param {string} handle
 */
export function profileUrl(handle) {
  return `https://instagram.com/${handle.replace(/^@/, '')}`;
}
