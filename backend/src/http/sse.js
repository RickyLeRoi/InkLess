// backend/src/http/sse.js

const HEARTBEAT_MS = 25_000;

/**
 * Opens a Server-Sent Events stream on a raw reply.
 *
 * 20260830 ++ RG #sse_transport
 * SSE instead of WebSocket: push is one-directional here (server tells the browser
 * and the RPi what happened), the daemon's replies are ordinary POSTs, and this keeps
 * the backend at zero extra transport dependencies.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @returns {{ send: (event: string, payload: unknown) => void, close: () => void }}
 */
export function openEventStream(request, reply) {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  reply.raw.write('retry: 3000\n\n');

  const heartbeat = setInterval(() => {
    reply.raw.write(': keep-alive\n\n');
  }, HEARTBEAT_MS);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    reply.raw.end();
  };

  request.raw.on('close', close);

  return {
    send(event, payload) {
      if (closed) return;
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    close
  };
}
