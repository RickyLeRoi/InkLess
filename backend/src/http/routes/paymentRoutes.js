// backend/src/http/routes/paymentRoutes.js

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {any} options
 */
export async function paymentRoutes(fastify, options) {
  const { confirmPayment } = options;

  /**
   * 20260830 ++ RG #raw_webhook_body
   * Signature verification runs over the exact bytes the provider signed, so this
   * plugin keeps the body as a Buffer. The parser is registered inside the plugin,
   * which means the rest of the API still receives parsed JSON.
   */
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body, done) => done(null, body)
  );

  fastify.post('/callback', async (request, reply) => {
    const result = await confirmPayment.execute(
      /** @type {Buffer} */ (request.body),
      /** @type {Record<string, string>} */ (request.headers)
    );
    return reply.status(200).send(result);
  });
}
