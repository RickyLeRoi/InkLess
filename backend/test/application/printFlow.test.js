// backend/test/application/printFlow.test.js

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createDatabase } from '../../src/adapters/persistence/database.js';
import { SqliteMessageRepository } from '../../src/adapters/persistence/SqliteMessageRepository.js';
import { SqlitePrintJobRepository } from '../../src/adapters/persistence/SqlitePrintJobRepository.js';
import { RegexModerationAdapter } from '../../src/adapters/moderation/RegexModerationAdapter.js';
import { FakePaymentAdapter } from '../../src/adapters/payment/FakePaymentAdapter.js';
import { InProcessPrintQueue } from '../../src/adapters/queue/InProcessPrintQueue.js';
import { ConfirmPayment } from '../../src/application/ConfirmPayment.js';
import { RequestPrint } from '../../src/application/RequestPrint.js';
import { SubmitMessage } from '../../src/application/SubmitMessage.js';
import { TrackPrintJob } from '../../src/application/TrackPrintJob.js';
import { PrintJobStatus } from '../../src/domain/PrintJob.js';

/** @type {any} */
let context;

beforeEach(() => {
  const db = createDatabase(':memory:');
  const messages = new SqliteMessageRepository(db);
  const jobs = new SqlitePrintJobRepository(db);
  const payments = new FakePaymentAdapter();
  const printQueue = new InProcessPrintQueue();

  context = {
    messages,
    jobs,
    payments,
    printQueue,
    submit: new SubmitMessage({ messages, moderation: new RegexModerationAdapter() }),
    requestPrint: new RequestPrint({
      messages,
      jobs,
      payments,
      publicBaseUrl: 'https://inkless.test'
    }),
    confirmPayment: new ConfirmPayment({ messages, jobs, payments, printQueue }),
    track: new TrackPrintJob({ messages, jobs })
  };
});

/** @param {string} paymentRef */
function callbackBody(paymentRef) {
  return Buffer.from(JSON.stringify({ paymentRef, paid: true }), 'utf8');
}

describe('submission', () => {
  it('publishes an innocuous message straight to the board', async () => {
    const { message, verdict } = await context.submit.execute({ text: 'Buon compleanno!' });
    assert.equal(verdict, 'auto_approve');
    assert.equal(message.isPublished, true);
  });

  it('holds a doubtful message for the admin', async () => {
    const { message, verdict } = await context.submit.execute({
      text: 'chiamami allo +39 333 444 5566'
    });
    assert.equal(verdict, 'needs_review');
    assert.equal(message.status, 'pending');
  });

  it('assigns progressive Doe identities to anonymous authors', async () => {
    const first = await context.submit.execute({ text: 'primo messaggio' });
    const second = await context.submit.execute({ text: 'secondo messaggio' });
    assert.equal(first.message.author, 'Doe#001');
    assert.equal(second.message.author, 'Doe#002');
  });

  /**
   * The handle is published on the board and printed on the receipt, so an innocuous
   * message signed with an offensive name must not sail through on the body alone.
   */
  it('judges the handle as well as the message', async () => {
    const { message, verdict, reasons } = await context.submit.execute({
      text: 'Buon compleanno nonna!',
      authorInstagram: '@porcodio90'
    });

    // The body alone would have been published on the spot.
    assert.equal(verdict, 'needs_review');
    assert.equal(message.status, 'pending');
    assert.ok(reasons.includes('handle_blasphemy'));
  });

  it('lets the body decide a rejection even when the handle is clean', async () => {
    const { message, verdict } = await context.submit.execute({
      text: 'sei un frocio',
      authorInstagram: '@ricky'
    });

    assert.equal(verdict, 'reject');
    assert.equal(message.status, 'rejected');
  });

  it('keeps the reasons from both halves', async () => {
    const { reasons } = await context.submit.execute({
      text: 'chiamami al 333 444 5566',
      authorInstagram: '@ilfrociodelsud'
    });

    assert.ok(reasons.includes('phone_number'));
    assert.ok(reasons.includes('handle_hate_speech'));
  });

  it('does not burn a Doe identity when a handle is supplied', async () => {
    await context.submit.execute({ text: 'con handle', authorInstagram: '@ricky' });
    const next = await context.submit.execute({ text: 'senza handle' });
    assert.equal(next.message.author, 'Doe#001');
  });
});

describe('paid print flow', () => {
  /** @param {number} amountCents */
  async function bookPrint(amountCents) {
    const { message } = await context.submit.execute({
      text: 'un messaggio da stampare',
      authorInstagram: '@autore'
    });
    const { job, redirectUrl } = await context.requestPrint.execute({
      messageId: message.id,
      printerInstagram: '@stampatore',
      amountCents
    });
    return { message, job, redirectUrl };
  }

  it('queues the job only once the payment is confirmed', async () => {
    const { job } = await bookPrint(100);
    assert.equal(job.status, PrintJobStatus.AWAITING_PAYMENT);

    const result = await context.confirmPayment.execute(callbackBody(job.paymentRef), {});
    assert.equal(result.queued, true);

    const stored = await context.jobs.findById(job.id);
    assert.equal(stored.status, PrintJobStatus.QUEUED);
  });

  it('hands the hardware a ready-made attribution line', async () => {
    const { job } = await bookPrint(100);
    /** @type {any[]} */
    const tickets = [];
    context.printQueue.subscribe(/** @param {any} ticket */ (ticket) => tickets.push(ticket));

    await context.confirmPayment.execute(callbackBody(job.paymentRef), {});

    assert.equal(tickets.length, 1);
    assert.equal(tickets[0].attribution, 'Scritto da: @autore - Stampato da: @stampatore');
    assert.equal(tickets[0].includesVideo, true);
  });

  it('collapses the attribution when author and printer match', async () => {
    const { message } = await context.submit.execute({
      text: 'stampo il mio',
      authorInstagram: '@ricky'
    });
    const { job } = await context.requestPrint.execute({
      messageId: message.id,
      printerInstagram: '@ricky',
      amountCents: 100
    });
    /** @type {any[]} */
    const tickets = [];
    context.printQueue.subscribe(/** @param {any} ticket */ (ticket) => tickets.push(ticket));
    await context.confirmPayment.execute(callbackBody(job.paymentRef), {});

    assert.equal(tickets[0].attribution, 'Scritto e stampato da: @ricky');
  });

  it('ignores a replayed webhook instead of printing twice', async () => {
    const { job } = await bookPrint(100);
    /** @type {any[]} */
    const tickets = [];
    context.printQueue.subscribe(/** @param {any} ticket */ (ticket) => tickets.push(ticket));

    await context.confirmPayment.execute(callbackBody(job.paymentRef), {});
    const replay = await context.confirmPayment.execute(callbackBody(job.paymentRef), {});

    assert.equal(replay.queued, false);
    assert.equal(replay.reason, 'already_processed');
    assert.equal(tickets.length, 1);
  });

  it('withholds the video below one euro', async () => {
    const { job } = await bookPrint(60);
    /** @type {any[]} */
    const tickets = [];
    context.printQueue.subscribe(/** @param {any} ticket */ (ticket) => tickets.push(ticket));
    await context.confirmPayment.execute(callbackBody(job.paymentRef), {});

    assert.equal(tickets[0].includesVideo, false);
  });

  it('refuses to print a message that is not on the board', async () => {
    const { message } = await context.submit.execute({ text: 'chiamami al 333 444 5566' });
    await assert.rejects(
      () => context.requestPrint.execute({ messageId: message.id, amountCents: 100 }),
      /Only an approved message can be printed/
    );
  });

  it('moves the board counter only when paper actually came out', async () => {
    const { message, job } = await bookPrint(100);
    await context.confirmPayment.execute(callbackBody(job.paymentRef), {});

    let stored = await context.messages.findById(message.id);
    assert.equal(stored.printCount, 0);

    await context.track.start(job.id);
    await context.track.complete(job.id, 'https://r2.test/clip.mp4');

    stored = await context.messages.findById(message.id);
    assert.equal(stored.printCount, 1);

    const finished = await context.jobs.findById(job.id);
    assert.equal(finished.status, PrintJobStatus.COMPLETED);
    assert.equal(finished.videoUrl, 'https://r2.test/clip.mp4');
  });

  it('leaves the counter alone when the print fails', async () => {
    const { message, job } = await bookPrint(100);
    await context.confirmPayment.execute(callbackBody(job.paymentRef), {});
    await context.track.fail(job.id, 'printer offline');

    const stored = await context.messages.findById(message.id);
    assert.equal(stored.printCount, 0);
  });
});
