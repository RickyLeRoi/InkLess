// backend/src/http/routes/publicRoutes.js

import { MESSAGE_MAX_LENGTH } from '../../domain/text.js';
import { MINIMUM_PRINT_CENTS } from '../../domain/PrintJob.js';
import { openEventStream } from '../sse.js';

const submitSchema = {
  body: {
    type: 'object',
    required: ['text'],
    additionalProperties: false,
    properties: {
      text: { type: 'string', minLength: 1, maxLength: MESSAGE_MAX_LENGTH },
      authorInstagram: { type: 'string', maxLength: 31 }
    }
  }
};

const boardSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      search: { type: 'string', maxLength: 100 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      offset: { type: 'integer', minimum: 0, default: 0 }
    }
  }
};

const printSchema = {
  body: {
    type: 'object',
    required: ['amountCents'],
    additionalProperties: false,
    properties: {
      amountCents: { type: 'integer', minimum: MINIMUM_PRINT_CENTS, maximum: 100_000 },
      printerInstagram: { type: 'string', maxLength: 31 }
    }
  }
};

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {any} options
 */
export async function publicRoutes(fastify, options) {
  const { config, submitMessage, listBoard, requestPrint, trackPrintJob, jobEvents } = options;

  fastify.post(
    '/messages',
    {
      schema: submitSchema,
      config: {
        rateLimit: {
          max: config.rateLimit.submissionsPerHour,
          timeWindow: '1 hour'
        }
      }
    },
    async (request, reply) => {
      const body = /** @type {{ text: string, authorInstagram?: string }} */ (request.body);
      const { message, verdict, reasons } = await submitMessage.execute(body);
      return reply.status(201).send({
        id: message.id,
        status: message.status,
        author: message.author,
        moderation: { verdict, reasons }
      });
    }
  );

  fastify.get('/messages', { schema: boardSchema }, async (request) => {
    const query = /** @type {import('../../ports/MessageRepository.js').BoardQuery} */ (
      request.query
    );
    return listBoard.execute(query);
  });

  fastify.get(
    '/messages/status',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['ids'],
          additionalProperties: false,
          properties: { ids: { type: 'string', maxLength: 2000 } }
        }
      }
    },
    async (request) => {
      const query = /** @type {{ ids: string }} */ (request.query);
      const ids = query.ids.split(',').filter(Boolean).slice(0, 50);
      return { items: await listBoard.statusOf(ids) };
    }
  );

  fastify.post(
    '/messages/:id/print',
    {
      schema: printSchema,
      config: {
        rateLimit: { max: config.rateLimit.printsPerHour, timeWindow: '1 hour' }
      }
    },
    async (request, reply) => {
      const { id } = /** @type {{ id: string }} */ (request.params);
      const body = /** @type {{ amountCents: number, printerInstagram?: string }} */ (
        request.body
      );

      const { job, redirectUrl } = await requestPrint.execute({
        messageId: id,
        printerInstagram: body.printerInstagram,
        amountCents: body.amountCents
      });
      return reply.status(201).send({ jobId: job.id, redirectUrl });
    }
  );

  fastify.get('/jobs/:id', async (request) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const job = await trackPrintJob.status(id);
    return job.toPublicJSON();
  });

  // Keeps the payer's tab updated while the queue drains.
  fastify.get('/jobs/:id/stream', async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const job = await trackPrintJob.status(id);

    const stream = openEventStream(request, reply);
    stream.send('status', job.toPublicJSON());

    const unsubscribe = jobEvents.subscribe(
      id,
      /** @param {any} payload */ (payload) => {
        stream.send('status', payload);
        if (payload.status === 'completed' || payload.status === 'failed') {
          stream.close();
        }
      }
    );

    request.raw.on('close', unsubscribe);
    return reply;
  });
}
