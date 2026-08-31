// backend/src/adapters/rateLimit/SqliteRateLimitStore.js

/**
 * 20260831 ++ RG #rate_limit_survives_a_restart
 * @fastify/rate-limit keeps its counters in an in-process LRU, so every deploy and
 * every crash handed the whole internet a fresh budget. Anyone who noticed could just
 * wait for a restart; worse, the restart is the one moment the container is cheapest
 * to trigger. The counters belong in the database that is already open.
 *
 * No new dependency: this implements the store contract the plugin documents
 * (`incr`, `read`, `child`) against node:sqlite.
 */

/** Rows are swept this often, counted in store operations rather than on a timer. */
const SWEEP_EVERY_OPERATIONS = 500;

/**
 * Namespace for one limiter, so the global 60/minute and a route's own budget never
 * share a row. Derived from the route rather than generated, because a random id would
 * be a different namespace after every restart — which is the bug this file exists to
 * fix. Two limiters with no route info and identical settings share a bucket, which
 * throttles more strictly rather than less: safe in the direction that matters.
 *
 * @param {any} params
 * @returns {string}
 */
function namespaceOf(params) {
  const route = params?.routeInfo ?? {};
  return [route.method, route.url, params?.max, params?.timeWindow]
    .filter((part) => part !== undefined && part !== null && part !== '')
    .join(' ');
}

/**
 * Builds the store class bound to one database. The plugin instantiates the class
 * itself (`new Store(params)`), so the connection has to arrive by closure.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {any} a constructor satisfying the @fastify/rate-limit store contract
 */
export function createSqliteRateLimitStore(db) {
  const statements = {
    get: db.prepare('SELECT count, started_at FROM rate_limits WHERE namespace = ? AND key = ?'),
    upsert: db.prepare(
      `INSERT INTO rate_limits (namespace, key, count, started_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET count = excluded.count,
                                                started_at = excluded.started_at`
    ),
    // A row is dead once the longest window anybody could be using has elapsed. The
    // sweep is deliberately generous: deleting a live counter would hand out a fresh
    // budget, which is the failure this whole file is about.
    sweep: db.prepare('DELETE FROM rate_limits WHERE started_at < ?')
  };

  let operations = 0;

  /** @param {number} now */
  function sweepOccasionally(now) {
    operations += 1;
    if (operations % SWEEP_EVERY_OPERATIONS !== 0) return;
    statements.sweep.run(now - 24 * 60 * 60 * 1000);
  }

  return class SqliteRateLimitStore {
    /** @param {any} params */
    constructor(params = {}) {
      this.params = params;
      this.namespace = namespaceOf(params);
      this.continueExceeding = params.continueExceeding === true;
      this.exponentialBackoff = params.exponentialBackoff === true;
    }

    /**
     * @param {string} key
     * @param {(error: Error | null, result?: { current: number, ttl: number }) => void} callback
     * @param {number} timeWindow
     * @param {number} max
     */
    incr(key, callback, timeWindow, max) {
      const now = Date.now();
      const row = statements.get.get(this.namespace, key);

      let current;
      let startedAt;

      if (!row || Number(row.started_at) + timeWindow <= now) {
        current = 1;
        startedAt = now;
      } else {
        current = Number(row.count) + 1;
        startedAt = Number(row.started_at);

        // Both mirror LocalStore rather than inventing a policy: a store that quietly
        // ignores an option the plugin accepts is a trap for whoever enables it later.
        if ((this.continueExceeding || this.exponentialBackoff) && current > max) {
          startedAt = now;
        }
      }

      statements.upsert.run(this.namespace, key, current, startedAt);

      let ttl = timeWindow - (now - startedAt);
      if (this.exponentialBackoff && current > max) {
        const scaled = timeWindow * 2 ** (current - max - 1);
        ttl = Number.isSafeInteger(scaled) ? scaled : Number.MAX_SAFE_INTEGER;
      }

      sweepOccasionally(now);
      callback(null, { current, ttl });
    }

    /**
     * Non-mutating peek, same argument shape as incr.
     *
     * @param {string} key
     * @param {(error: Error | null, result?: { current: number, ttl: number }) => void} callback
     * @param {number} timeWindow
     */
    read(key, callback, timeWindow) {
      const now = Date.now();
      const row = statements.get.get(this.namespace, key);

      if (!row || Number(row.started_at) + timeWindow <= now) {
        callback(null, { current: 0, ttl: 0 });
        return;
      }

      callback(null, {
        current: Number(row.count),
        ttl: timeWindow - (now - Number(row.started_at))
      });
    }

    /**
     * @param {any} routeParams
     * @returns {any}
     */
    child(routeParams) {
      return new SqliteRateLimitStore(routeParams);
    }
  };
}
