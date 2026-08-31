// e2e/lib/sse.js

/**
 * Minimal Server-Sent Events client over fetch.
 *
 * EventSource is a browser API and node:test has no DOM, but the transport between the
 * backend and both of its consumers is SSE — so an end-to-end test that skipped it would
 * be testing something the product does not do.
 */

/**
 * @param {string} frame
 * @returns {{ name: string, data: any } | null}
 */
function parseFrame(frame) {
  let name = 'message';
  const data = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }

  if (data.length === 0) return null;
  const raw = data.join('\n');
  try {
    return { name, data: JSON.parse(raw) };
  } catch {
    return { name, data: raw };
  }
}

/**
 * Opens the stream and starts collecting immediately, so the caller can subscribe
 * before triggering whatever it wants to observe.
 *
 * @param {string} url
 * @param {Record<string, string>} [headers]
 */
export function openEventStream(url, headers = {}) {
  const controller = new AbortController();
  /** @type {Array<{ name: string, data: any }>} */
  const events = [];
  /** @type {Array<() => void>} */
  let waiters = [];
  /** @type {Error | null} */
  let failure = null;
  let closed = false;

  const wake = () => {
    const pending = waiters;
    waiters = [];
    for (const resume of pending) resume();
  };

  const ready = (async () => {
    const response = await fetch(url, {
      headers: { Accept: 'text/event-stream', ...headers },
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      throw new Error(`${url} answered ${response.status}`);
    }

    void (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let cut = buffer.indexOf('\n\n');
          while (cut !== -1) {
            const parsed = parseFrame(buffer.slice(0, cut));
            buffer = buffer.slice(cut + 2);
            if (parsed) events.push(parsed);
            cut = buffer.indexOf('\n\n');
          }
          wake();
        }
      } catch (error) {
        if (!closed) failure = /** @type {Error} */ (error);
      } finally {
        closed = true;
        wake();
      }
    })();
  })();

  return {
    ready,
    events,

    /**
     * @param {(event: { name: string, data: any }) => boolean} predicate
     * @param {number} [timeoutMs]
     */
    async until(predicate, timeoutMs = 30_000) {
      await ready;
      const deadline = Date.now() + timeoutMs;
      let index = 0;

      for (;;) {
        while (index < events.length) {
          const event = events[index];
          index += 1;
          if (predicate(event)) return event;
        }
        if (failure) throw failure;
        if (closed) throw new Error(`${url} closed before the expected event arrived`);

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`timed out on ${url}; saw ${JSON.stringify(events)}`);
        }
        // The cap turns a missed wake-up into a slow pass instead of a hang.
        await new Promise((resume) => {
          const timer = setTimeout(resume, Math.min(remaining, 250));
          waiters.push(() => {
            clearTimeout(timer);
            resume();
          });
        });
      }
    },

    close() {
      closed = true;
      controller.abort();
    }
  };
}
