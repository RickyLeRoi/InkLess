// backend/src/ports/UnmatchedDonationRepository.js

/**
 * @typedef {object} UnmatchedDonation
 * @property {string} id
 * @property {string} kofiTransactionId
 * @property {number} amountCents
 * @property {string | null} fromName
 * @property {string | null} message
 * @property {string | null} email
 * @property {Date} receivedAt
 * @property {string | null} matchedJobId
 * @property {Date | null} matchedAt
 */

/**
 * @typedef {object} UnmatchedDonationRepository
 * @property {(donation: UnmatchedDonation) => Promise<void>} save
 * @property {(id: string) => Promise<UnmatchedDonation | null>} findById
 * @property {(kofiTransactionId: string) => Promise<UnmatchedDonation | null>} findByTransactionId
 * @property {() => Promise<UnmatchedDonation[]>} findUnmatched
 * @property {(id: string, jobId: string) => Promise<void>} markMatched
 */

export {};
