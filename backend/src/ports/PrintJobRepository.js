// backend/src/ports/PrintJobRepository.js

/**
 * @typedef {object} PrintJobRepository
 * @property {(job: import('../domain/PrintJob.js').PrintJob) => Promise<void>} save
 * @property {(id: string) => Promise<import('../domain/PrintJob.js').PrintJob | null>} findById
 * @property {(paymentRef: string) => Promise<import('../domain/PrintJob.js').PrintJob | null>} findByPaymentRef
 * @property {() => Promise<import('../domain/PrintJob.js').PrintJob[]>} findQueued
 */

export {};
