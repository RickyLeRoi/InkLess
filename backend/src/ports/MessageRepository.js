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
 * @property {(query: BoardQuery) => Promise<{ items: import('../domain/Message.js').Message[], total: number }>} findApproved
 * @property {(status: string) => Promise<import('../domain/Message.js').Message[]>} findByStatus
 * @property {() => Promise<number>} countAwaitingLlm
 * @property {(limit: number) => Promise<import('../domain/Message.js').Message[]>} findAwaitingLlm
 * @property {() => Promise<number>} nextAnonymousSequence
 */

export {};
