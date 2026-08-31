// backend/src/adapters/persistence/SqliteMessageRepository.js

import { Message } from '../../domain/Message.js';

const ANONYMOUS_COUNTER = 'anonymous_author';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * @param {Record<string, any>} row
 * @returns {Message}
 */
function toMessage(row) {
  return new Message({
    id: row.id,
    originalText: row.original_text,
    text: row.text,
    authorInstagram: row.author_instagram,
    authorSequence: row.author_sequence,
    status: row.status,
    printCount: row.print_count,
    createdAt: new Date(row.created_at),
    llmReviewedAt: row.llm_reviewed_at ? new Date(row.llm_reviewed_at) : null,
    moderationReasons: parseReasons(row.moderation_reasons)
  });
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseReasons(raw) {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** Satisfies the MessageRepository contract. */
export class SqliteMessageRepository {
  /** @param {import('node:sqlite').DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  /** @param {Message} message */
  async save(message) {
    this.db
      .prepare(
        `INSERT INTO messages
           (id, original_text, text, author_instagram, author_sequence, status,
            print_count, created_at, llm_reviewed_at, moderation_reasons)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           text = excluded.text,
           author_instagram = excluded.author_instagram,
           author_sequence = excluded.author_sequence,
           status = excluded.status,
           print_count = excluded.print_count,
           llm_reviewed_at = excluded.llm_reviewed_at,
           moderation_reasons = excluded.moderation_reasons`
      )
      .run(
        message.id,
        message.originalText,
        message.text,
        message.authorInstagram,
        message.authorSequence,
        message.status,
        message.printCount,
        message.createdAt.toISOString(),
        message.llmReviewedAt ? message.llmReviewedAt.toISOString() : null,
        JSON.stringify(message.moderationReasons)
      );
  }

  /**
   * @param {string} id
   * @returns {Promise<Message | null>}
   */
  async findById(id) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return row ? toMessage(row) : null;
  }

  /**
   * @param {import('../../ports/MessageRepository.js').BoardQuery} query
   * @returns {Promise<{ items: Message[], total: number }>}
   */
  async findApproved(query = {}) {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);
    const search = query.search?.trim();

    // LIKE is deliberate: the board holds a few thousand 200-char rows at most, and
    // FTS5 would buy nothing while adding a second table to keep in sync.
    const where = search
      ? `status = 'approved' AND (text LIKE :pattern ESCAPE '\\' OR author_instagram LIKE :pattern ESCAPE '\\')`
      : `status = 'approved'`;
    /** @type {Record<string, string | number>} */
    const params = {};
    if (search) params.pattern = `%${escapeLike(search)}%`;

    const total = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`)
      .get(params);

    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE ${where}
         ORDER BY created_at DESC
         LIMIT :limit OFFSET :offset`
      )
      .all({ ...params, limit, offset });

    return { items: rows.map(toMessage), total: Number(total?.n ?? 0) };
  }

  /**
   * @param {string} status
   * @returns {Promise<Message[]>}
   */
  async findByStatus(status) {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE status = ? ORDER BY created_at ASC')
      .all(status);
    return rows.map(toMessage);
  }

  /**
   * How many pending messages the model has never seen. This is the number the
   * escalation threshold is compared against.
   *
   * @returns {Promise<number>}
   */
  async countAwaitingLlm() {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE status = 'pending' AND llm_reviewed_at IS NULL"
      )
      .get();
    return Number(row?.n ?? 0);
  }

  /**
   * @param {number} limit
   * @returns {Promise<Message[]>}
   */
  async findAwaitingLlm(limit) {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE status = 'pending' AND llm_reviewed_at IS NULL
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(limit);
    return rows.map(toMessage);
  }

  /**
   * 20260830 ++ RG #anonymous_sequence
   * Single-statement upsert with RETURNING so the read and the increment cannot be
   * interleaved by a concurrent submission.
   *
   * @returns {Promise<number>}
   */
  async nextAnonymousSequence() {
    const row = this.db
      .prepare(
        `INSERT INTO counters (name, value) VALUES (?, 1)
         ON CONFLICT(name) DO UPDATE SET value = value + 1
         RETURNING value`
      )
      .get(ANONYMOUS_COUNTER);
    if (!row) throw new Error('Counter upsert returned no row');
    return Number(row.value);
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeLike(value) {
  return value.replace(/[%_]/g, (char) => `\\${char}`);
}
