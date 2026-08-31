// frontend/src/storage.js

const KEY = 'inkless.myMessages';
const MAX_TRACKED = 50;

/**
 * Ids of messages submitted from this browser. There are no accounts, so this list
 * is the only way to show an author what happened to what they wrote.
 *
 * Every access is guarded: private windows and blocked site data make localStorage
 * throw rather than return empty.
 *
 * @returns {string[]}
 */
export function readMyMessageIds() {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** @param {string} id */
export function rememberMessageId(id) {
  try {
    const existing = readMyMessageIds().filter((known) => known !== id);
    const updated = [id, ...existing].slice(0, MAX_TRACKED);
    window.localStorage.setItem(KEY, JSON.stringify(updated));
  } catch {
    // A viewer who blocks storage simply loses the follow-up view; nothing else breaks.
  }
}

export function forgetAll() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to do: there was nothing readable to begin with.
  }
}
