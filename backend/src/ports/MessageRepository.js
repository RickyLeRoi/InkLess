// backend/src/ports/MessageRepository.js

/**
 * Persistence contract for messages. Adapters must not leak storage concepts
 * (rows, connections, SQL) through this surface.
 *
 * @typedef {object} BoardQuery
 * @property {string} [search] free text matched against body and author
 * @property {number} [limit]
 * @property {number} [offset]
 *
 * @typedef {object} MessageRepository
 * @property {(message: import('../domain/Message.js').Message) => Promise<void>} save
 * @property {(id: string) => Promise<import('../domain/Message.js').Message | null>} findById
 * @property {FindApproved} findApproved
 * @property {(status: string) => Promise<import('../domain/Message.js').Message[]>} findByStatus
 * @property {() => Promise<number>} countAwaitingLlm
 * @property {(limit: number) => Promise<import('../domain/Message.js').Message[]>} findAwaitingLlm
 * @property {() => Promise<number>} nextAnonymousSequence
 */

/**
 * @typedef {object} BoardResult
 * @property {import('../domain/Message.js').Message[]} items
 * @property {number} total
 */

/**
 * @callback FindApproved
 * @param {BoardQuery} query
 * @returns {Promise<BoardResult>}
 */

export {};
