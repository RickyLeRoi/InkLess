// backend/test/adapters/PayPalPaymentAdapter.test.js

import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { crc32 } from 'node:zlib';
import { PayPalPaymentAdapter } from '../../src/adapters/payment/PayPalPaymentAdapter.js';

const WEBHOOK_ID = 'WH-INKLESS-1';
const CERT_URL = 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const certificate = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const realFetch = globalThis.fetch;
/** @type {Array<{ method: string, url: string, body: any }>} */
let calls;
/** @type {Map<string, { status?: number, body?: any, text?: string }>} */
let routes;

beforeEach(() => {
  calls = [];
  routes = new Map();
  routes.set('POST https://api-m.sandbox.paypal.com/v1/oauth2/token', {
    body: { access_token: 'token-1', expires_in: 32000 }
  });
  routes.set(`GET ${CERT_URL}`, { text: certificate });

  globalThis.fetch = async (/** @type {any} */ input, /** @type {any} */ init = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init.method ?? 'GET';
    // The token call is form-encoded; everything else is JSON.
    let body = null;
    if (init.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    calls.push({ method, url, body });

    const route = routes.get(`${method} ${url}`);
    if (!route) throw new Error(`unexpected call: ${method} ${url}`);

    const payload = route.text ?? JSON.stringify(route.body ?? {});
    return /** @type {any} */ ({
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      async text() {
        return payload;
      },
      async json() {
        return JSON.parse(payload);
      }
    });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function buildAdapter() {
  return new PayPalPaymentAdapter({
    clientId: 'client',
    clientSecret: 'secret',
    webhookId: WEBHOOK_ID,
    environment: 'sandbox'
  });
}

/**
 * Signs a webhook the way PayPal does: over the CRC32 of the exact bytes, never the
 * bytes themselves.
 *
 * @param {any} event
 * @param {{ certUrl?: string, webhookId?: string }} [options]
 */
function signedWebhook(event, options = {}) {
  const rawBody = Buffer.from(JSON.stringify(event), 'utf8');
  const transmissionId = 'tx-1';
  const transmissionTime = '2026-08-31T10:00:00Z';
  const signed = [
    transmissionId,
    transmissionTime,
    options.webhookId ?? WEBHOOK_ID,
    crc32(rawBody) >>> 0
  ].join('|');

  const signature = createSign('sha256').update(signed).sign(privateKey, 'base64');

  return {
    rawBody,
    headers: {
      'paypal-transmission-id': transmissionId,
      'paypal-transmission-time': transmissionTime,
      'paypal-transmission-sig': signature,
      'paypal-cert-url': options.certUrl ?? CERT_URL,
      'paypal-auth-algo': 'SHA256withRSA'
    }
  };
}

/** @param {string} [orderId] */
function approvalOf(orderId = 'ORDER-1') {
  return { event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: orderId } };
}

/** @param {string} value */
function captureOf(value) {
  return {
    status: 'COMPLETED',
    purchase_units: [
      { payments: { captures: [{ amount: { currency_code: 'EUR', value } }] } }
    ]
  };
}

describe('PayPalPaymentAdapter.createCheckout', () => {
  it('prices the order without ever touching a float', async () => {
    routes.set('POST https://api-m.sandbox.paypal.com/v2/checkout/orders', {
      body: {
        id: 'ORDER-1',
        links: [
          { rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-1' },
          { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1' }
        ]
      }
    });

    const ticket = await buildAdapter().createCheckout({
      jobId: 'job-1',
      amountCents: 60,
      description: 'Stampa di un messaggio',
      returnUrl: 'https://example.invalid/jobs/job-1'
    });

    assert.equal(ticket.paymentRef, 'ORDER-1');
    assert.equal(ticket.redirectUrl, 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1');

    const order = calls.at(-1)?.body;
    assert.equal(order.purchase_units[0].amount.value, '0.60');
    assert.equal(order.purchase_units[0].amount.currency_code, 'EUR');
    assert.equal(order.purchase_units[0].custom_id, 'job-1');
  });

  it('reuses the access token instead of asking for one per call', async () => {
    routes.set('POST https://api-m.sandbox.paypal.com/v2/checkout/orders', {
      body: { id: 'ORDER-1', links: [{ rel: 'approve', href: 'https://pay.invalid/1' }] }
    });

    const adapter = buildAdapter();
    const request = {
      jobId: 'job-1',
      amountCents: 100,
      description: 'Stampa',
      returnUrl: 'https://example.invalid/jobs/job-1'
    };
    await adapter.createCheckout(request);
    await adapter.createCheckout(request);

    const tokenCalls = calls.filter((call) => call.url.endsWith('/v1/oauth2/token'));
    assert.equal(tokenCalls.length, 1);
  });
});

describe('PayPalPaymentAdapter.verifyCallback', () => {
  it('refuses a certificate served from anywhere but PayPal', async () => {
    const { rawBody, headers } = signedWebhook(approvalOf(), {
      certUrl: 'https://evil.invalid/cert.pem'
    });

    await assert.rejects(() => buildAdapter().verifyCallback(rawBody, headers), /evil\.invalid/);
    assert.equal(
      calls.some((call) => call.url.includes('evil.invalid')),
      false,
      'la URL del certificato arriva dentro la richiesta da autenticare: non va nemmeno aperta'
    );
  });

  it('refuses a signature that does not match the body', async () => {
    const { rawBody, headers } = signedWebhook(approvalOf());
    const tampered = Buffer.from(JSON.stringify(approvalOf('ORDER-2')), 'utf8');

    await assert.rejects(
      () => buildAdapter().verifyCallback(tampered, headers),
      /signature does not match/
    );
  });

  it('refuses a webhook signed for a different endpoint', async () => {
    const { rawBody, headers } = signedWebhook(approvalOf(), { webhookId: 'WH-SOMEBODY-ELSE' });

    await assert.rejects(
      () => buildAdapter().verifyCallback(rawBody, headers),
      /signature does not match/
    );
  });

  it('captures an approved order and reports the exact cents', async () => {
    routes.set('POST https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-1/capture', {
      body: captureOf('1.00')
    });

    const { rawBody, headers } = signedWebhook(approvalOf());
    const confirmation = await buildAdapter().verifyCallback(rawBody, headers);

    assert.deepEqual(confirmation, { paymentRef: 'ORDER-1', amountCents: 100, paid: true });
  });

  it('treats a replayed approval as paid rather than as a failure', async () => {
    routes.set('POST https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-1/capture', {
      status: 422,
      body: { details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }
    });
    routes.set('GET https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-1', {
      body: captureOf('0.60')
    });

    const { rawBody, headers } = signedWebhook(approvalOf());
    const confirmation = await buildAdapter().verifyCallback(rawBody, headers);

    // Paid, so ConfirmPayment reaches PrintJob.markPaid() — which is the thing that
    // refuses the second queueing. Reporting "not paid" here would hide the replay
    // from the one guard built to handle it.
    assert.deepEqual(confirmation, { paymentRef: 'ORDER-1', amountCents: 60, paid: true });
  });

  it('ignores the capture events PayPal emits after the fact', async () => {
    const { rawBody, headers } = signedWebhook({
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'CAPTURE-1' }
    });

    const confirmation = await buildAdapter().verifyCallback(rawBody, headers);

    assert.equal(confirmation.paid, false);
    assert.equal(
      calls.some((call) => call.url.includes('/capture')),
      false,
      'un evento di conferma non deve far ripartire una cattura'
    );
  });

  it('refuses an order in the wrong currency', async () => {
    routes.set('POST https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-1/capture', {
      body: {
        status: 'COMPLETED',
        purchase_units: [
          { payments: { captures: [{ amount: { currency_code: 'USD', value: '1.00' } }] } }
        ]
      }
    });

    const { rawBody, headers } = signedWebhook(approvalOf());
    await assert.rejects(() => buildAdapter().verifyCallback(rawBody, headers), /USD/);
  });
});
