// backend/src/http/server.js

import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
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
    // 20260830 ++ RG #client_ip_behind_tunnel
    // Every public request arrives from cloudflared, so without this the rate limiter
    // would see one address for the whole internet. Safe only because the container
    // is unreachable except through the tunnel — never expose this port directly.
    trustProxy: true,
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
    timeWindow: '1 minute'
  });

  fastify.get('/health', async () => ({
    status: 'ok',
    hardwareOnline: await deps.printQueue.isHardwareOnline()
  }));

  await fastify.register(publicRoutes, { prefix: '/api', ...deps });
  await fastify.register(adminRoutes, { prefix: '/api/admin', ...deps });
  await fastify.register(paymentRoutes, { prefix: '/api/payments', ...deps });
  await fastify.register(hardwareRoutes, { prefix: '/internal', ...deps });

  return fastify;
}
