// backend/test/http/clientAddress.test.js

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { composeApp } from '../../src/composition.js';
import { loadConfig } from '../../src/config/env.js';
import { buildServer } from '../../src/http/server.js';

/** @type {any} */
let app;
/** @type {import('fastify').FastifyInstance} */
let server;

const ADMIN_AUTH = `Basic ${Buffer.from('admin:inkless-dev').toString('base64')}`;
const WRONG_AUTH = `Basic ${Buffer.from('admin:not-the-password').toString('base64')}`;

/**
 * Two submissions per hour, so the third is the one that has to be refused. Keeping
 * the budget tiny keeps the test from making sixty requests to prove a point.
 */
beforeEach(async () => {
  const config = {
    ...loadConfig(),
    databasePath: ':memory:',
    rateLimit: { submissionsPerHour: 2, printsPerHour: 2 }
  };
  app = composeApp(config);
  server = await buildServer(app);
});

afterEach(async () => {
  await server.close();
});

/**
 * @param {Record<string, string>} headers
 */
async function submit(headers) {
  return server.inject({
    method: 'POST',
    url: '/api/messages',
    headers,
    payload: { text: `un messaggio innocuo numero ${Math.random()}` }
  });
}

describe('rate limiting is keyed on something the caller cannot choose', () => {
  it('does not hand out a fresh budget per forged X-Forwarded-For', async () => {
    // 20260831 ++ RG #forgeable_client_ip
    // The regression this exists for: with trustProxy:true, request.ip was the leftmost
    // XFF entry, so rotating this header reset the counter on every request and the
    // "3 messages per hour" rule was decorative.
    assert.equal((await submit({ 'x-forwarded-for': '203.0.113.1' })).statusCode, 201);
    assert.equal((await submit({ 'x-forwarded-for': '203.0.113.2' })).statusCode, 201);

    const third = await submit({ 'x-forwarded-for': '203.0.113.3' });
    assert.equal(third.statusCode, 429, 'a forged forwarding header must not reset the budget');
  });

  it('still separates two genuine visitors seen by Cloudflare', async () => {
    // The flip side: the fix must not collapse the whole internet into one bucket.
    // CF-Connecting-IP is written by the edge, so these really are two people.
    assert.equal((await submit({ 'cf-connecting-ip': '203.0.113.10' })).statusCode, 201);
    assert.equal((await submit({ 'cf-connecting-ip': '203.0.113.10' })).statusCode, 201);
    assert.equal((await submit({ 'cf-connecting-ip': '203.0.113.10' })).statusCode, 429);

    const other = await submit({ 'cf-connecting-ip': '203.0.113.11' });
    assert.equal(other.statusCode, 201, 'a different visitor must get their own budget');
  });
});

describe('admin login throttling', () => {
  it('counts failed attempts per socket, not per claimed address', async () => {
    // Without this the 30/minute ceiling is worthless: one header per guess and the
    // password can be attacked at full speed.
    let refused = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await server.inject({
        method: 'GET',
        url: '/api/admin/messages',
        headers: {
          authorization: WRONG_AUTH,
          'x-forwarded-for': `198.51.100.${attempt}`,
          'cf-connecting-ip': `198.51.100.${attempt}`
        }
      });
      if (response.statusCode === 429) refused += 1;
    }

    assert.ok(refused > 0, 'rotating headers must not buy an unlimited number of guesses');
  });

  it('lets the real admin through before the throttle bites', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/admin/messages',
      headers: { authorization: ADMIN_AUTH }
    });
    assert.equal(response.statusCode, 200);
  });
});

describe('GET /api/admin/hardware', () => {
  it('reports the node state to an authenticated admin', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/admin/hardware',
      headers: { authorization: ADMIN_AUTH }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().online, false);
  });

  it('refuses an anonymous caller', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/admin/hardware' });
    assert.equal(response.statusCode, 401);
  });

  it('is no longer readable from the public health endpoint', async () => {
    const response = await server.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().hardwareOnline, undefined);
  });
});
