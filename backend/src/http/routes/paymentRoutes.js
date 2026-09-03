// backend/src/http/routes/paymentRoutes.js

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {any} options
 */
export async function paymentRoutes(fastify, options) {
  const { confirmPaymentByProvider, trackPrintJob, jobEvents } = options;

  /**
   * 20260830 ++ RG #raw_webhook_body
   * Signature verification runs over the exact bytes the provider signed, so this
   * plugin keeps the body as a Buffer. The parser is registered inside the plugin,
   * which means the rest of the API still receives parsed JSON.
   *
   * 20260903 ++ RG #kofi_form_encoded
   * Ko-fi posts application/x-www-form-urlencoded rather than JSON — its whole payload
   * is one 'data' field holding a JSON string — but it still needs the raw bytes,
   * since KofiPaymentAdapter decodes the form itself.
   */
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body, done) => done(null, body)
  );
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'buffer' },
    (request, body, done) => done(null, body)
  );

  /**
   * 20260903 ++ RG #one_route_per_provider
   * Was a single generic /callback resolved through whichever adapter PAYMENT_PROVIDER
   * named. Each provider now calls back its own registered URL (nginx forwards /stripe,
   * /paypal, /kofi at the root here), and composition.js hands over one ConfirmPayment
   * per configured adapter — including ones PAYMENT_PROVIDER no longer names, so a late
   * webhook from a provider retired mid-project still resolves instead of 404ing.
   */
  for (const [provider, confirmPayment] of Object.entries(confirmPaymentByProvider)) {
    fastify.post(`/${provider}`, async (request, reply) => {
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
}
