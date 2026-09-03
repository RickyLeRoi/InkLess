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

const KOFI_CODE_KEY = 'inkless.pendingKofiCode';
const MAX_TRACKED_CODES = 10;

/**
 * The code a Ko-fi payer must carry into the donation message, plus the page URL
 * they were sent to. Ko-fi has no return URL, so PrintDialog opens it in another tab
 * and sends this one straight to the job's wait page instead — this is how that page
 * still gets to show the code, and re-open Ko-fi if the payer closed that tab without
 * paying (see PrintDialog#kofi_has_no_return_url).
 *
 * 20260903 ++ RG #kofi_reopen
 *
 * @param {string} jobId
 * @param {{ code: string, redirectUrl: string }} pending
 */
export function rememberPendingKofiCode(jobId, { code, redirectUrl }) {
  try {
    const raw = window.localStorage.getItem(KOFI_CODE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const existing = parsed && typeof parsed === 'object' ? parsed : {};
    const trimmed = Object.fromEntries(Object.entries(existing).slice(-(MAX_TRACKED_CODES - 1)));
    window.localStorage.setItem(
      KOFI_CODE_KEY,
      JSON.stringify({ ...trimmed, [jobId]: { code, redirectUrl } })
    );
  } catch {
    // The payer just won't see the code again if they leave and come back.
  }
}

/**
 * @param {string} jobId
 * @returns {{ code: string, redirectUrl: string } | null}
 */
export function readPendingKofi(jobId) {
  try {
    const raw = window.localStorage.getItem(KOFI_CODE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const entry = parsed?.[jobId];
    return typeof entry?.code === 'string' && typeof entry?.redirectUrl === 'string' ? entry : null;
  } catch {
    return null;
  }
}
