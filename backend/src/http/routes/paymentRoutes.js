// backend/src/http/routes/paymentRoutes.js

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {any} options
 */
export async function paymentRoutes(fastify, options) {
  const { confirmPayment, trackPrintJob, jobEvents } = options;

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

    /**
     * 20260831 ++ RG #queued_is_a_visible_state
     * Without this the payer's tab keeps reading "awaiting_payment" until the printer
     * starts, which with a busy queue is minutes of the wrong state on the page of
     * somebody who has just paid. Publishing here rather than inside ConfirmPayment
     * keeps the event bus a transport concern, exactly like the hardware callbacks do.
     */
    if (result.queued && result.jobId) {
      const job = await trackPrintJob.status(result.jobId);
      jobEvents.publish(job.id, job.toPublicJSON());
    }

    return reply.status(200).send(result);
  });
}
