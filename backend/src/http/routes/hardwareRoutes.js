// backend/src/http/routes/hardwareRoutes.js

import { timingSafeEqual } from 'node:crypto';
import { formatAttribution } from '../../domain/identity.js';
import { openEventStream } from '../sse.js';

/**
 * @param {string} a
 * @param {string} b
 */
function constantTimeEquals(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * LAN-only surface consumed by the Python daemon on the RPi 4.
 * Never routed through the Cloudflare tunnel.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {any} options
 */
export async function hardwareRoutes(fastify, options) {
  const { config, printQueue, trackPrintJob, jobEvents, messages, jobs } = options;

  fastify.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!constantTimeEquals(token, config.hardwareToken)) {
      return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Invalid hardware token' });
    }
  });

  /**
   * 20260830 ++ RG #queue_catch_up
   * The daemon replays this on every (re)connect. Without it, any job paid while the
   * RPi was rebooting or offline would sit in the table forever: the SSE stream only
   * carries what happens while somebody is listening.
   */
  fastify.get('/jobs/queued', async () => {
    const queued = await jobs.findQueued();
    const tickets = [];
    for (const job of queued) {
      const message = await messages.findById(job.messageId);
      if (!message) continue;
      tickets.push({
        jobId: job.id,
        text: message.text,
        attribution: formatAttribution(
          message.author,
          job.printerInstagram ? `@${job.printerInstagram}` : null
        ),
        includesVideo: job.includesVideo
      });
    }
    return { items: tickets };
  });

  fastify.get('/print-stream', async (request, reply) => {
    const stream = openEventStream(request, reply);
    stream.send('ready', { online: true });

    const unsubscribe = printQueue.subscribe(
      /** @param {any} ticket */ (ticket) => stream.send('ticket', ticket)
    );
    request.raw.on('close', unsubscribe);

    return reply;
  });

  fastify.post('/jobs/:id/start', async (request) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const job = await trackPrintJob.start(id);
    jobEvents.publish(job.id, job.toPublicJSON());
    return { status: job.status };
  });

  fastify.post(
    '/jobs/:id/complete',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { videoUrl: { type: 'string', format: 'uri', maxLength: 500 } }
        }
      }
    },
    async (request) => {
      const { id } = /** @type {{ id: string }} */ (request.params);
      const body = /** @type {{ videoUrl?: string }} */ (request.body ?? {});
      const job = await trackPrintJob.complete(id, body.videoUrl ?? null);
      jobEvents.publish(job.id, job.toPublicJSON());
      return { status: job.status };
    }
  );

  fastify.post(
    '/jobs/:id/fail',
    {
      schema: {
        body: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: { reason: { type: 'string', maxLength: 200 } }
        }
      }
    },
    async (request) => {
      const { id } = /** @type {{ id: string }} */ (request.params);
      const { reason } = /** @type {{ reason: string }} */ (request.body);
      const job = await trackPrintJob.fail(id, reason);
      jobEvents.publish(job.id, job.toPublicJSON());
      return { status: job.status };
    }
  );
}
