// backend/test/adapters/SqliteRateLimitStore.test.js

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createSqliteRateLimitStore } from '../../src/adapters/rateLimit/SqliteRateLimitStore.js';
import { createDatabase } from '../../src/adapters/persistence/database.js';

/** @type {import('node:sqlite').DatabaseSync} */
let db;
/** @type {any} */
let Store;

const WINDOW = 60_000;
const MAX = 3;

beforeEach(() => {
  db = createDatabase(':memory:');
  Store = createSqliteRateLimitStore(db);
});

/**
 * The plugin's contract is callback-shaped; the tests read better as promises.
 *
 * @param {any} store
 * @param {string} key
 */
function incr(store, key) {
  return new Promise((resolve, reject) => {
    store.incr(key, (/** @type {any} */ error, /** @type {any} */ result) => {
      if (error) reject(error);
      else resolve(result);
    }, WINDOW, MAX);
  });
}

/**
 * @param {any} store
 * @param {string} key
 */
function read(store, key) {
  return new Promise((resolve, reject) => {
    store.read(key, (/** @type {any} */ error, /** @type {any} */ result) => {
      if (error) reject(error);
      else resolve(result);
    }, WINDOW, MAX);
  });
}

describe('SqliteRateLimitStore', () => {
  it('counts up within a window', async () => {
    const store = new Store({ max: MAX, timeWindow: WINDOW });
    assert.equal((await incr(store, 'a')).current, 1);
    assert.equal((await incr(store, 'a')).current, 2);
    assert.equal((await incr(store, 'a')).current, 3);
  });

  it('keeps separate callers apart', async () => {
    const store = new Store({ max: MAX, timeWindow: WINDOW });
    await incr(store, 'a');
    await incr(store, 'a');
    assert.equal((await incr(store, 'b')).current, 1);
  });

  it('survives the process that was counting', async () => {
    // 20260831 ++ RG #rate_limit_survives_a_restart
    // The whole point. A second store over the same database is what a restarted
    // container looks like: with the old LRU the count came back as 1.
    const before = new Store({ max: MAX, timeWindow: WINDOW });
    await incr(before, 'a');
    await incr(before, 'a');

    const after = createSqliteRateLimitStore(db);
    const restarted = new after({ max: MAX, timeWindow: WINDOW });
    assert.equal((await incr(restarted, 'a')).current, 3, 'a restart must not reset the budget');
  });

  it('gives a route its own namespace', async () => {
    const root = new Store({ max: MAX, timeWindow: WINDOW });
    const route = root.child({
      max: MAX,
      timeWindow: WINDOW,
      routeInfo: { method: 'POST', url: '/api/messages' }
    });

    await incr(root, 'a');
    assert.equal((await incr(route, 'a')).current, 1, 'the route must not inherit the global count');
  });

  it('gives the same route the same namespace after a restart', async () => {
    const route = { max: MAX, timeWindow: WINDOW, routeInfo: { method: 'POST', url: '/api/messages' } };

    await incr(new Store({ max: MAX, timeWindow: WINDOW }).child(route), 'a');

    const after = createSqliteRateLimitStore(db);
    const restarted = new after({ max: MAX, timeWindow: WINDOW }).child(route);
    assert.equal((await incr(restarted, 'a')).current, 2, 'the namespace must be derived, not generated');
  });

  it('starts a new window once the old one has elapsed', async () => {
    const store = new Store({ max: MAX, timeWindow: WINDOW });
    await incr(store, 'a');

    // Reach past the clock rather than waiting a minute for it.
    db.prepare('UPDATE rate_limits SET started_at = ?').run(Date.now() - WINDOW - 1);

    assert.equal((await incr(store, 'a')).current, 1);
  });

  it('reads without counting', async () => {
    const store = new Store({ max: MAX, timeWindow: WINDOW });
    await incr(store, 'a');

    assert.equal((await read(store, 'a')).current, 1);
    assert.equal((await read(store, 'a')).current, 1, 'read must not mutate');
    assert.equal((await incr(store, 'a')).current, 2);
  });

  it('reports a clean slate for a caller it has never seen', async () => {
    const store = new Store({ max: MAX, timeWindow: WINDOW });
    assert.deepEqual(await read(store, 'nobody'), { current: 0, ttl: 0 });
  });
});
