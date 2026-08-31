// backend/src/http/clientAddress.js

/**
 * 20260831 ++ RG #forgeable_client_ip
 * Who a request is "from" has two different answers here, and using the wrong one is
 * what made every rate limit decorative.
 *
 * Public traffic arrives browser -> Cloudflare -> cloudflared -> nginx -> here, and
 * every hop *appends* to X-Forwarded-For rather than replacing it. So the leftmost
 * entry of that header is written by the caller, and anything keyed on it is reset by
 * sending a different value. `CF-Connecting-IP` is the opposite: Cloudflare overwrites
 * it at the edge on every request, so a client cannot dictate it from the internet.
 *
 * The hardware and admin surfaces are also reachable directly on the LAN, with no
 * proxy in front. There no header means anything at all, and only the socket the
 * bytes actually came in on is trustworthy.
 */

const CLOUDFLARE_CLIENT_IP = 'cf-connecting-ip';

/**
 * Rate-limit key for the public API.
 *
 * There are exactly two ways to reach this application, and each has one honest
 * answer. Through the tunnel, `CF-Connecting-IP` is the edge's own view of the
 * visitor. Straight at the port on the LAN, no header means anything and the socket
 * is all there is.
 *
 * Deliberately never `request.ip`: that is resolved from X-Forwarded-For, and on the
 * direct path there is no proxy to vouch for it, so it is once again the caller's to
 * write. Falling back to it looked right and left the whole bypass in place on the
 * LAN — which is exactly the surface the topology deliberately leaves open.
 *
 * @param {import('fastify').FastifyRequest} request
 * @returns {string}
 */
export function publicClientKey(request) {
  const header = request.headers[CLOUDFLARE_CLIENT_IP];
  if (typeof header === 'string' && header !== '') return header;
  return socketAddress(request);
}

/**
 * The only address no header can move.
 *
 * Used to throttle admin logins and to fence `/internal`: both are reachable straight
 * off the LAN, where honouring a forwarding header would let the caller pick the
 * identity they are throttled or authorised as.
 *
 * @param {import('fastify').FastifyRequest} request
 * @returns {string}
 */
export function socketAddress(request) {
  return request.socket.remoteAddress ?? 'unknown';
}
