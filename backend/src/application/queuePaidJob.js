// backend/src/application/queuePaidJob.js

import { NotFoundError } from '../domain/errors.js';
import { formatAttribution } from '../domain/identity.js';

/**
 * The tail shared by ConfirmPayment and MatchKofiDonation once a job is known to be
 * paid: mark it, persist it, and hand the hardware node a ticket. Split out so the two
 * call sites — a provider webhook and an admin's manual match — cannot drift apart on
 * what "paid" actually queues.
 *
 * @param {object} deps
 * @param {import('../ports/MessageRepository.js').MessageRepository} deps.messages
 * @param {import('../ports/PrintJobRepository.js').PrintJobRepository} deps.jobs
 * @param {import('../ports/PrintQueuePort.js').PrintQueuePort} deps.printQueue
 * @param {import('../domain/PrintJob.js').PrintJob} job
 * @returns {Promise<{ queued: boolean, jobId: string | null, reason?: string }>}
 */
export async function queuePaidJob({ messages, jobs, printQueue }, job) {
  const justQueued = job.markPaid();
  await jobs.save(job);

  if (!justQueued) {
    return { queued: false, jobId: job.id, reason: 'already_processed' };
  }

  const message = await messages.findById(job.messageId);
  if (!message) throw new NotFoundError('Message', job.messageId);

  await printQueue.publish({
    jobId: job.id,
    text: message.text,
    attribution: formatAttribution(
      message.author,
      job.printerInstagram ? `@${job.printerInstagram}` : null
    ),
    includesVideo: job.includesVideo
  });

  return { queued: true, jobId: job.id };
}
