// frontend/src/api.js

const BASE = import.meta.env.VITE_API_BASE ?? '/api';

/**
 * @param {string} path
 * @param {RequestInit} [options]
 */
async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });

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

/** @param {string[]} ids */
export function fetchStatuses(ids) {
  if (ids.length === 0) return Promise.resolve({ items: [] });
  return request(`/messages/status?ids=${encodeURIComponent(ids.join(','))}`);
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
