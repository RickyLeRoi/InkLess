// backend/src/adapters/persistence/SqliteUnmatchedDonationRepository.js

/**
 * @param {Record<string, any>} row
 * @returns {import('../../ports/UnmatchedDonationRepository.js').UnmatchedDonation}
 */
function toDonation(row) {
  return {
    id: row.id,
    kofiTransactionId: row.kofi_transaction_id,
    amountCents: row.amount_cents,
    fromName: row.from_name,
    message: row.message,
    email: row.email,
    receivedAt: new Date(row.received_at),
    matchedJobId: row.matched_job_id,
    matchedAt: row.matched_at ? new Date(row.matched_at) : null
  };
}

/** Satisfies the UnmatchedDonationRepository contract. */
export class SqliteUnmatchedDonationRepository {
  /** @param {import('node:sqlite').DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * 20260903 ++ RG #kofi_webhook_retries
   * Ko-fi retries a webhook it did not get a 200 for, with the same transaction id.
   * ON CONFLICT DO NOTHING keeps a retried "could not match" from logging twice.
   *
   * @param {import('../../ports/UnmatchedDonationRepository.js').UnmatchedDonation} donation
   */
  async save(donation) {
    this.db
      .prepare(
        `INSERT INTO kofi_unmatched_donations
           (id, kofi_transaction_id, amount_cents, from_name, message, email, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kofi_transaction_id) DO NOTHING`
      )
      .run(
        donation.id,
        donation.kofiTransactionId,
        donation.amountCents,
        donation.fromName,
        donation.message,
        donation.email,
        donation.receivedAt.toISOString()
      );
  }

  /**
   * @param {string} id
   * @returns {Promise<import('../../ports/UnmatchedDonationRepository.js').UnmatchedDonation | null>}
   */
  async findById(id) {
    const row = this.db.prepare('SELECT * FROM kofi_unmatched_donations WHERE id = ?').get(id);
    return row ? toDonation(row) : null;
  }

  /**
   * @param {string} kofiTransactionId
   * @returns {Promise<import('../../ports/UnmatchedDonationRepository.js').UnmatchedDonation | null>}
   */
  async findByTransactionId(kofiTransactionId) {
    const row = this.db
      .prepare('SELECT * FROM kofi_unmatched_donations WHERE kofi_transaction_id = ?')
      .get(kofiTransactionId);
    return row ? toDonation(row) : null;
  }

  /** @returns {Promise<import('../../ports/UnmatchedDonationRepository.js').UnmatchedDonation[]>} */
  async findUnmatched() {
    const rows = this.db
      .prepare(
        'SELECT * FROM kofi_unmatched_donations WHERE matched_job_id IS NULL ORDER BY received_at ASC'
      )
      .all();
    return rows.map(toDonation);
  }

  /**
   * @param {string} id
   * @param {string} jobId
   */
  async markMatched(id, jobId) {
    this.db
      .prepare(
        'UPDATE kofi_unmatched_donations SET matched_job_id = ?, matched_at = ? WHERE id = ?'
      )
      .run(jobId, new Date().toISOString(), id);
  }
}
