// backend/src/http/server.js

import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { publicClientKey } from './clientAddress.js';
import { registerErrorHandler } from './errors.js';
import { adminRoutes } from './routes/adminRoutes.js';
import { hardwareRoutes } from './routes/hardwareRoutes.js';
import { paymentRoutes } from './routes/paymentRoutes.js';
import { publicRoutes } from './routes/publicRoutes.js';

/**
 * Wires the transport onto an already-built set of use cases.
 *
 * @param {any} deps
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildServer(deps) {
  const { config } = deps;

  const fastify = Fastify({
    logger: config.isProduction ? true : { level: 'warn' },
    // 20260831 ** RG #forgeable_client_ip
    // Was `true`, which in Fastify means 'believe every hop': proxy-addr then resolves
    // request.ip to the leftmost X-Forwarded-For entry, and every hop in front of us
    // appends rather than replaces, so that entry is written by the caller. One header
    // and every counter reset — including the admin login throttle. A list of trusted
    // ranges stops the walk at the first address nobody local vouched for.
    trustProxy: config.trustedProxies,
    bodyLimit: 16 * 1024,
    // Fastify strips unknown body fields by default. Rejecting them instead turns a
    // silently ignored payload into a 400 the caller can actually see.
    ajv: { customOptions: { removeAdditional: false } }
  });

  registerErrorHandler(fastify);

  await fastify.register(cors, {
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','),
    methods: ['GET', 'POST', 'PATCH']
  });

  // 20260831 ** RG #rate_limit_default_on
  // Was global:false with only submit/print opting in — board search, job status, the
  // SSE streams and the payment webhook were all unthrottled. Flipping the default closes
  // that by construction: a route added later is covered unless someone deliberately
  // opts it out, instead of being silently unprotected until someone remembers to opt it
  // in. Submit/print keep their own tighter config.rateLimit, which still wins per-route.
  await fastify.register(rateLimit, {
    global: true,
    max: 60,
    timeWindow: '1 minute',
    // 20260831 ++ RG #forgeable_client_ip
    // request.ip is now honest about which hop it stopped at, but behind Cloudflare
    // that hop is a shared edge address: every visitor would land in the same bucket.
    // CF-Connecting-IP is the per-visitor value, and the edge overwrites it on every
    // request, so it cannot be dictated from the internet. Route-level configs inherit
    // this generator, so submit and print are keyed the same way.
    keyGenerator: publicClientKey
  });

  // 20260831 ** RG #health_says_only_that_it_is_up
  // Whether the printer node is connected moved to the admin API. This endpoint is
  // unauthenticated and reachable from the LAN, and the Docker healthcheck only ever
  // looked at the status code.
  fastify.get('/health', async () => ({ status: 'ok' }));

  await fastify.register(publicRoutes, { prefix: '/api', ...deps });
  await fastify.register(adminRoutes, { prefix: '/api/admin', ...deps });
  await fastify.register(paymentRoutes, { prefix: '/api/payments', ...deps });
  await fastify.register(hardwareRoutes, { prefix: '/internal', ...deps });

  return fastify;
}
