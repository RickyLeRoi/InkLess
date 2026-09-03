// backend/src/adapters/persistence/SqlitePrintJobRepository.js

import { PrintJob } from '../../domain/PrintJob.js';

/**
 * @param {Record<string, any>} row
 * @returns {PrintJob}
 */
function toPrintJob(row) {
  const job = new PrintJob({
    id: row.id,
    messageId: row.message_id,
    printerInstagram: row.printer_instagram,
    amountCents: row.amount_cents,
    paymentRef: row.payment_ref,
    status: row.status,
    videoUrl: row.video_url,
    createdAt: new Date(row.created_at)
  });
  job.failureReason = row.failure_reason ?? null;
  return job;
}

/** Satisfies the PrintJobRepository contract. */
export class SqlitePrintJobRepository {
  /** @param {import('node:sqlite').DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  /** @param {PrintJob} job */
  async save(job) {
    this.db
      .prepare(
        `INSERT INTO print_jobs
           (id, message_id, printer_instagram, amount_cents, payment_ref, status, video_url, failure_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payment_ref = excluded.payment_ref,
           -- 20260903 ** RG #donor_controlled_amount
           -- ConfirmPayment can now raise amountCents when a Ko-fi payer sends more
           -- than the job was requested for (see ConfirmPayment.js); without this the
           -- upgrade computed in memory never reached the row, and includesVideo on
           -- the next read would derive from the stale, pre-upgrade figure.
           amount_cents = excluded.amount_cents,
           status = excluded.status,
           video_url = excluded.video_url,
           failure_reason = excluded.failure_reason`
      )
      .run(
        job.id,
        job.messageId,
        job.printerInstagram,
        job.amountCents,
        job.paymentRef,
        job.status,
        job.videoUrl,
        job.failureReason ?? null,
        job.createdAt.toISOString()
      );
  }

  /**
   * @param {string} id
   * @returns {Promise<PrintJob | null>}
   */
  async findById(id) {
    const row = this.db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id);
    return row ? toPrintJob(row) : null;
  }

  /**
   * @param {string} paymentRef
   * @returns {Promise<PrintJob | null>}
   */
  async findByPaymentRef(paymentRef) {
    const row = this.db.prepare('SELECT * FROM print_jobs WHERE payment_ref = ?').get(paymentRef);
    return row ? toPrintJob(row) : null;
  }

  /** @returns {Promise<PrintJob[]>} */
  async findQueued() {
    const rows = this.db
      .prepare("SELECT * FROM print_jobs WHERE status = 'queued' ORDER BY created_at ASC")
      .all();
    return rows.map(toPrintJob);
  }
}
