// backend/test/http/hardwareAccess.test.js

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { composeApp } from '../../src/composition.js';
import { loadConfig } from '../../src/config/env.js';
import { buildServer } from '../../src/http/server.js';

const HARDWARE_AUTH = 'Bearer inkless-dev-hardware';

/** @type {import('fastify').FastifyInstance | null} */
let server = null;

/** @param {string[]} hardwareAllowedIps */
async function serverAllowing(hardwareAllowedIps) {
  const config = { ...loadConfig(), databasePath: ':memory:', hardwareAllowedIps };
  server = await buildServer(composeApp(config));
  return server;
}

afterEach(async () => {
  if (server) await server.close();
  server = null;
});

/**
 * server.inject reports the socket as 127.0.0.1 unless told otherwise, which is
 * exactly the knob this test needs: remoteAddress is what the guard reads.
 *
 * @param {import('fastify').FastifyInstance} instance
 * @param {string} [remoteAddress]
 */
function fetchQueue(instance, remoteAddress) {
  return instance.inject({
    method: 'GET',
    url: '/internal/jobs/queued',
    headers: { authorization: HARDWARE_AUTH },
    ...(remoteAddress ? { remoteAddress } : {})
  });
}

describe('the hardware channel is fenced by address as well as by token', () => {
  it('lets the configured node in', async () => {
    const instance = await serverAllowing(['192.168.1.254']);
    const response = await fetchQueue(instance, '192.168.1.254');
    assert.equal(response.statusCode, 200);
  });

  it('refuses another machine on the same flat LAN, token and all', async () => {
    // 20260831 ++ RG #hardware_channel_is_not_for_everyone
    // The network has no VLANs, so "holds the token" used to mean every device in the
    // house — including the ESP32s and whatever a guest joined with.
    const instance = await serverAllowing(['192.168.1.254']);
    const response = await fetchQueue(instance, '192.168.1.99');
    assert.equal(response.statusCode, 403);
  });

  it('cannot be talked past with a forwarding header', async () => {
    // The guard reads the socket, never request.ip: a header is the caller's to write,
    // and there is no proxy in front of this route to make one mean anything.
    const instance = await serverAllowing(['192.168.1.254']);
    const response = await instance.inject({
      method: 'GET',
      url: '/internal/jobs/queued',
      headers: {
        authorization: HARDWARE_AUTH,
        'x-forwarded-for': '192.168.1.254',
        'cf-connecting-ip': '192.168.1.254'
      },
      remoteAddress: '192.168.1.99'
    });
    assert.equal(response.statusCode, 403);
  });

  it('matches an IPv4 address reported through a dual-stack socket', async () => {
    const instance = await serverAllowing(['192.168.1.254']);
    const response = await fetchQueue(instance, '::ffff:192.168.1.254');
    assert.equal(response.statusCode, 200, 'the ::ffff: form is the same machine');
  });

  it('still demands the token from an allowed address', async () => {
    const instance = await serverAllowing(['192.168.1.254']);
    const response = await instance.inject({
      method: 'GET',
      url: '/internal/jobs/queued',
      headers: { authorization: 'Bearer wrong' },
      remoteAddress: '192.168.1.254'
    });
    assert.equal(response.statusCode, 401);
  });

  it('checks no address when the allowlist is empty', async () => {
    // Development and the e2e stack run without one; an empty list must not lock out
    // the very node the feature exists to admit.
    const instance = await serverAllowing([]);
    const response = await fetchQueue(instance, '10.11.12.13');
    assert.equal(response.statusCode, 200);
  });
});
