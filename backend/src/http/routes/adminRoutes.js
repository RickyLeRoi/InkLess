// backend/src/http/routes/adminRoutes.js

import { timingSafeEqual } from 'node:crypto';
import { MESSAGE_MAX_LENGTH } from '../../domain/text.js';
import { socketAddress } from '../clientAddress.js';

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeEquals(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {any} options
 */
export async function adminRoutes(fastify, options) {
  const { config, moderateMessage, escalation, printQueue } = options;

  // 20260831 ++ RG #admin_rate_limit
  // Basic auth on its own has no lockout: without this, a weak admin password can be
  // brute-forced straight against the API, no browser involved. Registered before the
  // auth hook below so failed attempts get throttled too, not just successful ones — the
  // rate-limit plugin's route-config mode only attaches to a route's own onRequest hooks,
  // which run after plugin-level ones, so this has to be wired in by hand instead.
  //
  // 20260831 ** RG #forgeable_client_ip
  // Keyed on the socket, not on any header. This surface answers on the LAN as well as
  // through the tunnel, and there is no proxy in front of the LAN path: keying it on a
  // forwarded address would let an attacker draw a fresh 30-attempt budget per guess,
  // which is the whole protection gone. Through the tunnel every attempt shares nginx's
  // address, so the 30/minute becomes a global ceiling — correct for a one-person panel.
  fastify.addHook(
    'onRequest',
    fastify.rateLimit({ max: 30, timeWindow: '1 minute', keyGenerator: socketAddress })
  );

  // 20260830 ++ RG #admin_basic_auth
  // Basic auth is the in-app floor, not the whole defence: the spec puts the admin
  // subdomain behind Cloudflare Access as well. Comparison is constant-time so the
  // password cannot be recovered a byte at a time.
  fastify.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Basic ')) {
      reply.header('WWW-Authenticate', 'Basic realm="inkless-admin"');
      return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Credentials required' });
    }

    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const user = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);

    const ok =
      constantTimeEquals(user, config.admin.user) &&
      constantTimeEquals(password, config.admin.password);

    if (!ok) {
      return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Invalid credentials' });
    }
  });

  fastify.get(
    '/messages',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['pending', 'approved', 'rejected'], default: 'pending' }
          }
        }
      }
    },
    async (request) => {
      const { status } = /** @type {{ status: string }} */ (request.query);
      const messages = await moderateMessage.listByStatus(status);
      return {
        items: messages.map(/** @param {any} message */ (message) => ({
          ...message.toPublicJSON(),
          status: message.status,
          originalText: message.originalText,
          wasCensored: message.wasCensored,
          authorInstagram: message.authorInstagram,
          // Which rules fired, so the queue explains itself instead of just listing.
          moderationReasons: message.moderationReasons,
          // Tells the admin which rows the model has already given up on, so the
          // queue can be sorted by "actually needs me" rather than by arrival.
          llmReviewed: message.llmReviewedAt !== null,
          needsHuman: message.needsHuman
        }))
      };
    }
  );

  // Moved off the public /health, which is unauthenticated and answers on the LAN.
  fastify.get('/hardware', async () => ({
    online: await printQueue.isHardwareOnline()
  }));

  // Forces a batch regardless of the threshold, for when the queue is small but the
  // admin would rather not read it by hand.
  fastify.post('/moderation/escalate', async () => {
    return escalation.run();
  });

  fastify.post('/messages/:id/approve', async (request) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const message = await moderateMessage.approve(id);
    return { id: message.id, status: message.status };
  });

  fastify.post('/messages/:id/reject', async (request) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const message = await moderateMessage.reject(id);
    return { id: message.id, status: message.status };
  });

  // Pulls something off the public board after the fact — for whatever the automatic
  // pass waved through by mistake. Same effect as a rejection, kept as its own route
  // because it is reached from the board rather than from the moderation queue.
  fastify.post('/messages/:id/takedown', async (request) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const message = await moderateMessage.takeDown(id);
    return { id: message.id, status: message.status };
  });

  fastify.patch(
    '/messages/:id',
    {
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            text: { type: 'string', minLength: 1, maxLength: MESSAGE_MAX_LENGTH },
            // An empty string anonymises the author back to a Doe number.
            authorInstagram: { type: 'string', maxLength: 31 },
            // No default: AJV would insert it and satisfy minProperties, letting an
            // empty patch through as a no-op that reports success.
            approve: { type: 'boolean' }
          }
        }
      }
    },
    async (request) => {
      const { id } = /** @type {{ id: string }} */ (request.params);
      const body = /** @type {{ text?: string, authorInstagram?: string, approve?: boolean }} */ (
        request.body
      );

      const message = await moderateMessage.censor(id, {
        text: body.text,
        authorInstagram:
          body.authorInstagram === undefined
            ? undefined
            : body.authorInstagram.trim() === ''
              ? null
              : body.authorInstagram,
        approve: body.approve
      });

      return {
        id: message.id,
        status: message.status,
        text: message.text,
        author: message.author
      };
    }
  );
}
