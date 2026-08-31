// backend/src/adapters/payment/PayPalPaymentAdapter.js

import { createVerify } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { ValidationError } from '../../domain/errors.js';

const CURRENCY = 'EUR';

const API_BASE = Object.freeze({
  live: 'https://api-m.paypal.com',
  sandbox: 'https://api-m.sandbox.paypal.com'
});

/**
 * Hosts allowed to serve the webhook signing certificate. The URL arrives inside the
 * request being authenticated, so without this an attacker points it at a certificate
 * of their own and every signature they forge verifies.
 */
const CERT_HOSTS = Object.freeze([
  'api.paypal.com',
  'api.sandbox.paypal.com',
  'api-m.paypal.com',
  'api-m.sandbox.paypal.com'
]);

/**
 * PayPal over its REST API, same reasoning as the Stripe adapter: a handful of calls
 * does not justify an SDK. Nothing PayPal-shaped escapes this file — see PaymentPort.
 *
 * Two things differ from Stripe and shape the code below:
 *
 * - **Webhooks are RSA-signed, not HMAC.** Verification needs PayPal's public
 *   certificate, fetched once and cached, and the signed payload is built from the
 *   CRC32 of the raw bytes rather than the bytes themselves.
 * - **Approval is not payment.** An Orders v2 order has to be captured after the buyer
 *   approves it, so `verifyCallback` finishes the dance instead of only reading it.
 *
 * Satisfies the PaymentPort contract.
 */
/**
 * @typedef {object} PayPalCredentials
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {string} webhookId
 * @property {string} [environment]
 */

export class PayPalPaymentAdapter {
  /**
   * @param {PayPalCredentials} credentials
   */
  constructor({ clientId, clientSecret, webhookId, environment = 'live' }) {
    if (!clientId || !clientSecret || !webhookId) {
      throw new Error('PayPal adapter needs a client id, a client secret and a webhook id');
    }
    if (!(environment in API_BASE)) {
      throw new Error(`PAYPAL_ENVIRONMENT must be live or sandbox, got: ${environment}`);
    }

    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.webhookId = webhookId;
    this.baseUrl = API_BASE[/** @type {'live' | 'sandbox'} */ (environment)];

    /** @type {{ value: string, expiresAt: number } | null} */
    this.token = null;
    /** @type {Map<string, string>} */
    this.certificates = new Map();
  }

  /**
   * @param {import('../../ports/PaymentPort.js').CheckoutRequest} request
   * @returns {Promise<import('../../ports/PaymentPort.js').CheckoutTicket>}
   */
  async createCheckout(request) {
    const order = await this.#call('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [
        {
          custom_id: request.jobId,
          description: request.description.slice(0, 127),
          amount: { currency_code: CURRENCY, value: amountFromCents(request.amountCents) }
        }
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: `${request.returnUrl}?paid=1`,
            cancel_url: `${request.returnUrl}?paid=0`,
            user_action: 'PAY_NOW'
          }
        }
      }
    });

    // 'payer-action' is what the experience_context flow returns; 'approve' is the older
    // shape. Accepting both costs one line and survives PayPal changing its mind.
    const link = (order.links ?? []).find(
      (/** @type {any} */ candidate) =>
        candidate.rel === 'payer-action' || candidate.rel === 'approve'
    );
    if (!link) throw new Error('PayPal created an order with nowhere to send the payer');

    return { paymentRef: order.id, redirectUrl: link.href };
  }

  /**
   * @param {Buffer} rawBody
   * @param {Record<string, string>} headers
   * @returns {Promise<import('../../ports/PaymentPort.js').PaymentConfirmation>}
   */
  async verifyCallback(rawBody, headers) {
    await this.#verifySignature(rawBody, headers);

    const event = JSON.parse(rawBody.toString('utf8'));
    const resource = event?.resource ?? {};

    /**
     * Only the buyer's approval is acted on. The capture events PayPal emits afterwards
     * describe work this adapter already did, and replaying them must not look like a
     * second payment.
     */
    if (event.event_type !== 'CHECKOUT.ORDER.APPROVED') {
      return { paymentRef: resource.id ?? '', amountCents: 0, paid: false };
    }

    return this.#capture(resource.id);
  }

  /**
   * Approval only reserves the money; this is where it moves.
   *
   * A retried webhook lands here twice, and the second capture is refused as
   * ORDER_ALREADY_CAPTURED. That is not an error: the order is paid, so the order is
   * read back and reported as paid. PrintJob.markPaid() is what makes the replay
   * harmless from there on.
   *
   * @param {string} orderId
   * @returns {Promise<import('../../ports/PaymentPort.js').PaymentConfirmation>}
   */
  async #capture(orderId) {
    if (!orderId) throw new ValidationError('PayPal approval carried no order id');

    const captured = await this.#call('POST', `/v2/checkout/orders/${orderId}/capture`, {}, [422]);

    if (captured.status === 'COMPLETED') {
      return {
        paymentRef: orderId,
        amountCents: capturedCents(captured),
        paid: true
      };
    }

    const alreadyDone = (captured.details ?? []).some(
      (/** @type {any} */ detail) => detail.issue === 'ORDER_ALREADY_CAPTURED'
    );
    if (!alreadyDone) {
      throw new Error(`PayPal refused to capture order ${orderId}: ${JSON.stringify(captured)}`);
    }

    const order = await this.#call('GET', `/v2/checkout/orders/${orderId}`);
    return {
      paymentRef: orderId,
      amountCents: capturedCents(order),
      paid: order.status === 'COMPLETED'
    };
  }

  /**
   * 20260831 ++ RG #paypal_signature_check
   * Verified locally against PayPal's certificate rather than by asking PayPal to check
   * it for us: the round trip would have to re-serialise the event, and JSON that came
   * back out of a parser is no longer the bytes that were signed.
   *
   * @param {Buffer} rawBody
   * @param {Record<string, string>} headers
   */
  async #verifySignature(rawBody, headers) {
    const transmissionId = headers['paypal-transmission-id'];
    const transmissionTime = headers['paypal-transmission-time'];
    const signature = headers['paypal-transmission-sig'];
    const certUrl = headers['paypal-cert-url'];
    const algorithm = headers['paypal-auth-algo'] ?? 'SHA256withRSA';

    if (!transmissionId || !transmissionTime || !signature || !certUrl) {
      throw new ValidationError('Missing PayPal signature headers');
    }
    if (algorithm !== 'SHA256withRSA') {
      throw new ValidationError(`Unsupported PayPal signature algorithm: ${algorithm}`);
    }

    const certificate = await this.#certificate(certUrl);
    const checksum = crc32(rawBody) >>> 0;
    const signed = `${transmissionId}|${transmissionTime}|${this.webhookId}|${checksum}`;

    const verifier = createVerify('sha256').update(signed);
    let matches = false;
    try {
      matches = verifier.verify(certificate, signature, 'base64');
    } catch {
      throw new ValidationError('PayPal signature could not be checked against the certificate');
    }
    if (!matches) throw new ValidationError('PayPal signature does not match');
  }

  /**
   * @param {string} certUrl
   * @returns {Promise<string>}
   */
  async #certificate(certUrl) {
    const cached = this.certificates.get(certUrl);
    if (cached) return cached;

    /** @type {URL} */
    let parsed;
    try {
      parsed = new URL(certUrl);
    } catch {
      throw new ValidationError('PayPal certificate URL is not a URL');
    }
    if (parsed.protocol !== 'https:' || !CERT_HOSTS.includes(parsed.hostname)) {
      throw new ValidationError(`Refusing a certificate from ${parsed.hostname}`);
    }

    const response = await fetch(parsed, { headers: { Accept: 'application/x-pem-file' } });
    if (!response.ok) {
      throw new Error(`Could not fetch the PayPal certificate: ${response.status}`);
    }

    const pem = await response.text();
    this.certificates.set(certUrl, pem);
    return pem;
  }

  /**
   * Client-credentials token, reused until shortly before it expires.
   *
   * @returns {Promise<string>}
   */
  async #accessToken() {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const response = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });

    if (!response.ok) {
      throw new Error(`PayPal refused the credentials: ${response.status}`);
    }

    const payload = await response.json();
    // A minute of margin, so a token never expires between this check and the call.
    const lifetimeMs = Math.max((Number(payload.expires_in) || 0) - 60, 0) * 1000;
    this.token = { value: payload.access_token, expiresAt: Date.now() + lifetimeMs };
    return this.token.value;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {any} [body]
   * @param {number[]} [tolerated] statuses returned to the caller instead of thrown
   * @returns {Promise<any>}
   */
  async #call(method, path, body, tolerated = []) {
    const token = await this.#accessToken();
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};

    if (!response.ok && !tolerated.includes(response.status)) {
      throw new Error(`PayPal answered ${response.status} on ${path}: ${text}`);
    }
    return payload;
  }
}

/**
 * Cents to the decimal string PayPal wants, without ever going through a float.
 *
 * @param {number} cents
 */
function amountFromCents(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * And back again. Parsed off the string rather than multiplied by 100: "0.29" times a
 * hundred is 28.999999999999996, and the tier boundaries here are money.
 *
 * @param {unknown} value
 */
function centsFromAmount(value) {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new ValidationError(`PayPal sent an amount this adapter will not guess at: ${value}`);
  }
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/**
 * @param {any} order
 */
function capturedCents(order) {
  const unit = (order.purchase_units ?? [])[0] ?? {};
  const capture = (unit.payments?.captures ?? [])[0];
  const amount = capture?.amount ?? unit.amount;
  if (!amount) throw new ValidationError('PayPal order carried no amount');
  if (amount.currency_code !== CURRENCY) {
    throw new ValidationError(`PayPal order is in ${amount.currency_code}, not ${CURRENCY}`);
  }
  return centsFromAmount(amount.value);
}
