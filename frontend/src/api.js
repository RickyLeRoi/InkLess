// frontend/src/api.js

const BASE = import.meta.env.VITE_API_BASE ?? '/api';

/**
 * @param {string} path
 * @param {RequestInit} [options]
 */
async function request(path, options = {}) {
  // 20260902 ** RG #empty_json_body
  // Same rule as the admin client: a bodyless POST — the appeal — must not announce a
  // JSON body it does not carry, or Fastify answers 400 before the route is reached.
  /** @type {Record<string, string>} */
  const headers = { ...options.headers };
  if (options.body !== undefined && options.body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${BASE}${path}`, { ...options, headers });

  const payload = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(payload?.message ?? 'Richiesta fallita');
    error.code = payload?.error;
    error.status = response.status;
    throw error;
  }
  return payload;
}

/**
 * @param {{ text: string, authorInstagram?: string }} input
 */
export function submitMessage(input) {
  const body = { text: input.text };
  if (input.authorInstagram) body.authorInstagram = input.authorInstagram;
  return request('/messages', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * @param {{ search?: string, limit?: number, offset?: number }} query
 */
export function fetchBoard(query = {}) {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.offset) params.set('offset', String(query.offset));
  const suffix = params.toString();
  return request(`/messages${suffix ? `?${suffix}` : ''}`);
}

/**
 * One published message, for a link that points at a single entry instead of the
 * whole board.
 *
 * @param {string} id
 */
export function fetchMessage(id) {
  return request(`/messages/${encodeURIComponent(id)}`);
}

/** @param {string[]} ids */
export function fetchStatuses(ids) {
  if (ids.length === 0) return Promise.resolve({ items: [] });
  return request(`/messages/status?ids=${encodeURIComponent(ids.join(','))}`);
}

/**
 * Asks a human to look again at a rejection.
 *
 * @param {string} id
 */
export function requestAppeal(id) {
  return request(`/messages/${encodeURIComponent(id)}/appeal`, { method: 'POST' });
}

/**
 * @param {string} messageId
 * @param {{ amountCents: number, printerInstagram?: string }} input
 */
export function requestPrint(messageId, input) {
  const body = { amountCents: input.amountCents };
  if (input.printerInstagram) body.printerInstagram = input.printerInstagram;
  return request(`/messages/${messageId}/print`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

/** @param {string} jobId */
export function fetchJob(jobId) {
  return request(`/jobs/${jobId}`);
}

/**
 * Live job updates. Falls back to nothing if the browser drops the stream —
 * the caller keeps the last known status rather than showing an error.
 *
 * @param {string} jobId
 * @param {(payload: any) => void} onStatus
 * @returns {() => void} unsubscribe
 */
export function streamJob(jobId, onStatus) {
  const source = new EventSource(`${BASE}/jobs/${jobId}/stream`);
  source.addEventListener('status', (event) => {
    onStatus(JSON.parse(event.data));
  });
  return () => source.close();
}
