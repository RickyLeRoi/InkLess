// frontend/src/adminSession.js

const KEY = 'inkless.adminAuth';

/**
 * 20260831 ++ RG #admin_ui_is_not_the_gate
 * Holding the credentials here only decides which buttons the board draws. Every
 * admin route checks Basic auth server-side and sits behind Cloudflare Access, so
 * forging this value in devtools buys a button that answers 401.
 *
 * sessionStorage, not localStorage: closing the tab is enough to drop it.
 *
 * @returns {string}
 */
export function readAdminAuth() {
  try {
    return window.sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

/** @param {string} value */
export function storeAdminAuth(value) {
  try {
    window.sessionStorage.setItem(KEY, value);
  } catch {
    // Not fatal: the admin logs in again on the next page load.
  }
}

export function clearAdminAuth() {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing readable to clear.
  }
}

/** @returns {boolean} */
export function isAdmin() {
  return readAdminAuth() !== '';
}

const BASE = import.meta.env.VITE_API_BASE ?? '/api';

/**
 * @param {string} path
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
export async function adminFetch(path, options = {}) {
  // 20260902 ** RG #empty_json_body
  // The content type goes on only when a body actually follows. Fastify's JSON parser
  // rejects an empty payload outright, so declaring it on the bodyless POSTs — approve,
  // reject, takedown, escalate — turned every one of them into a 400.
  /** @type {Record<string, string>} */
  const headers = { Authorization: readAdminAuth(), ...options.headers };
  if (options.body !== undefined && options.body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${BASE}/admin${path}`, { ...options, headers });

  if (response.status === 401) {
    clearAdminAuth();
    throw new Error('Credenziali rifiutate');
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? 'Richiesta fallita');
  return payload;
}
