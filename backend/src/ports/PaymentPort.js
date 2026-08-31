// backend/src/ports/PaymentPort.js

/**
 * Provider-neutral payment contract.
 *
 * 20260830 ++ RG #payment_provider_neutrality
 * Stripe is the chosen provider but PayPal was deliberately kept viable, so no
 * provider vocabulary (checkout sessions, provider-shaped webhook envelopes) may
 * appear here or in the domain. Adapters translate; `paymentRef` is opaque.
 *
 * @typedef {object} CheckoutRequest
 * @property {string} jobId
 * @property {number} amountCents
 * @property {string} description
 * @property {string} returnUrl
 *
 * @typedef {object} CheckoutTicket
 * @property {string} paymentRef opaque provider reference stored on the print job
 * @property {string} redirectUrl where the browser must be sent to pay
 *
 * @typedef {object} PaymentConfirmation
 * @property {string} paymentRef
 * @property {number} amountCents
 * @property {boolean} paid
 *
 * @typedef {object} PaymentPort
 * @property {(request: CheckoutRequest) => Promise<CheckoutTicket>} createCheckout
 * @property {VerifyCallback} verifyCallback
 */

/**
 * @callback VerifyCallback
 * @param {Buffer} rawBody
 * @param {Record<string, string>} headers
 * @returns {Promise<PaymentConfirmation>}
 */

export {};
