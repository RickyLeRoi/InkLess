// backend/src/http/errors.js

import {
  IllegalTransitionError,
  NotFoundError,
  ValidationError
} from '../domain/errors.js';

/**
 * Translates domain failures into status codes, so use cases never import HTTP.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export function registerErrorHandler(fastify) {
  fastify.setErrorHandler(
    /**
     * @param {any} error
     * @param {import('fastify').FastifyRequest} request
     * @param {import('fastify').FastifyReply} reply
     */
    (error, request, reply) => {
      if (error instanceof ValidationError) {
        return reply.status(400).send({ error: error.code, message: error.message });
      }
      if (error instanceof NotFoundError) {
        return reply.status(404).send({ error: error.code, message: error.message });
      }
      if (error instanceof IllegalTransitionError) {
        return reply.status(409).send({ error: error.code, message: error.message });
      }

      if (error.statusCode && error.statusCode < 500) {
        return reply.status(error.statusCode).send({
          error: error.code ?? 'BAD_REQUEST',
          message: error.message
        });
      }

      // Anything unclassified is ours, not the caller's: log it and stay vague outside.
      request.log.error({ err: error }, 'unhandled error');
      return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Unexpected failure' });
    }
  );
}
