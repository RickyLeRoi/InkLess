// backend/src/ports/PrintJobRepository.js

/**
 * @callback FindByPaymentRef
 * @param {string} paymentRef
 * @returns {Promise<import('../domain/PrintJob.js').PrintJob | null>}
 */

/**
 * @typedef {object} PrintJobRepository
 * @property {(job: import('../domain/PrintJob.js').PrintJob) => Promise<void>} save
 * @property {(id: string) => Promise<import('../domain/PrintJob.js').PrintJob | null>} findById
 * @property {FindByPaymentRef} findByPaymentRef
 * @property {() => Promise<import('../domain/PrintJob.js').PrintJob[]>} findQueued
 */

export {};
