// e2e/flow.test.js

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { openEventStream } from './lib/sse.js';
import { Stack, waitUntil } from './lib/stack.js';

const stack = new Stack();

before(async () => {
  await stack.start();
});

after(async () => {
  await stack.stop();
});

/**
 * Submits and, when moderation parks it, approves it the way an admin would.
 *
 * @param {string} text
 * @returns {Promise<{ id: string, submittedStatus: string, author: string }>}
 */
async function publish(text) {
  const submitted = await stack.json('POST', '/api/messages', { body: { text } });
  assert.equal(submitted.status, 201, `submission refused: ${JSON.stringify(submitted.body)}`);

  if (submitted.body.status !== 'approved') {
    const approved = await stack.json('POST', `/api/admin/messages/${submitted.body.id}/approve`, {
      admin: true
    });
    assert.equal(approved.status, 200, `approval refused: ${JSON.stringify(approved.body)}`);
  }

  return {
    id: submitted.body.id,
    submittedStatus: submitted.body.status,
    author: submitted.body.author
  };
}

/**
 * @param {string} messageId
 * @param {number} amountCents
 * @param {string} [printerInstagram]
 */
async function requestAndPay(messageId, amountCents, printerInstagram) {
  const body = printerInstagram ? { amountCents, printerInstagram } : { amountCents };
  const requested = await stack.json('POST', `/api/messages/${messageId}/print`, { body });
  assert.equal(requested.status, 201, `print refused: ${JSON.stringify(requested.body)}`);

  const paymentRef = new URL(requested.body.redirectUrl).searchParams.get('paymentRef');
  assert.ok(paymentRef, 'the checkout must hand back a payment reference');

  return {
    jobId: /** @type {string} */ (requested.body.jobId),
    /** The provider's webhook, replayable exactly like the real ones. */
    async pay() {
      const callback = await stack.json('POST', '/api/payments/callback', {
        body: { paymentRef, paid: true }
      });
      assert.equal(callback.status, 200, `callback refused: ${JSON.stringify(callback.body)}`);
      return callback.body;
    }
  };
}

describe('dal messaggio alla carta', () => {
  it('attraversa moderazione, pagamento, coda SSE e stampa', async () => {
    // "minchia" is on the SUSPICIOUS list: vulgar in one sentence, affectionate in the
    // next, so the regex tier parks it on a human instead of binning it.
    const message = await publish('minchia che bella idea');
    assert.equal(message.submittedStatus, 'pending', 'un termine ambiguo va all admin, non in pagina');
    assert.equal(message.author, 'Doe#001', 'senza handle il messaggio riceve un identita generata');

    const job = await requestAndPay(message.id, 100, 'stampatore');

    // Subscribed before paying, exactly like the browser sitting on the job page.
    const stream = openEventStream(`${stack.baseUrl}/api/jobs/${job.jobId}/stream`);
    const initial = await stream.until((event) => event.name === 'status');
    assert.equal(initial.data.status, 'awaiting_payment');

    const confirmation = await job.pay();
    assert.deepEqual(confirmation, { queued: true, jobId: job.jobId });

    const completed = await stream.until(
      (event) => event.name === 'status' && event.data.status === 'completed'
    );
    stream.close();

    const seen = stream.events.filter((event) => event.name === 'status').map((e) => e.data.status);
    assert.deepEqual(
      [...new Set(seen)],
      ['awaiting_payment', 'queued', 'printing', 'completed'],
      `chi ha pagato deve vedere ogni passaggio, "in coda" compreso: ${seen.join(' -> ')}`
    );
    assert.ok(completed.data.videoUrl, 'a 1,00 EUR il lavoro deve restituire l URL della clip');

    // Flattened before matching: the receipt is wrapped to a 32-column roll, so both
    // the text and the attribution legitimately arrive split across lines.
    const receipt = stack.spool().replace(/\s+/g, ' ');
    assert.match(receipt, /minchia che bella idea/, 'il testo deve finire sulla carta');
    assert.match(
      receipt,
      /Scritto da: Doe#001 - Stampato da: @stampatore/,
      'autore e stampatore vanno accreditati separatamente'
    );

    const board = await stack.json('GET', `/api/messages?search=${encodeURIComponent('bella idea')}`);
    assert.equal(board.status, 200);
    const entry = board.body.items.find((/** @type {any} */ item) => item.id === message.id);
    assert.ok(entry, 'il messaggio approvato deve comparire in bacheca');
    assert.equal(entry.printCount, 1, 'il contatore si muove solo a stampa riuscita');
  });

  it('non perde un lavoro pagato mentre il nodo hardware e spento', async () => {
    await stack.stopDaemon();

    const message = await publish('un saluto dal collaudo');
    assert.equal(message.submittedStatus, 'approved');

    const job = await requestAndPay(message.id, 60);
    await job.pay();

    const parked = await stack.json('GET', `/api/jobs/${job.jobId}`);
    assert.equal(parked.body.status, 'queued', 'senza nodo il lavoro resta in coda, non fallisce');
    assert.equal(parked.body.includesVideo, false, 'sotto 1,00 EUR non si registra nulla');

    await stack.startDaemon();

    const finished = await waitUntil('il lavoro ripreso dopo la riconnessione', async () => {
      const current = await stack.json('GET', `/api/jobs/${job.jobId}`);
      return current.body.status === 'completed' ? current.body : null;
    });
    assert.equal(finished.videoUrl, null, 'la clip non era pagata');

    // The catch-up fetch and the live stream deliver the same job on every reconnect.
    // The receipt footer carries the job id, so the paper itself is the proof that
    // PrintWorker.submit de-duplicated instead of charging once and printing twice.
    const stamps = stack.spool().split(`#${job.jobId.slice(0, 8)}`).length - 1;
    assert.equal(stamps, 1, `il lavoro e stato stampato ${stamps} volte`);
  });

  it('si spegne su SIGTERM invece di aspettare il timeout di systemd', async () => {
    // The daemon lives blocked on a read of the SSE socket. If the shutdown handler does
    // not close that socket, `systemctl stop` hangs until TimeoutStopSec and the unit
    // ends up killed rather than stopped.
    const elapsed = await stack.stopDaemon('SIGTERM');
    assert.ok(elapsed < 5_000, `il demone ci ha messo ${elapsed}ms a uscire`);

    await stack.startDaemon();
  });
});
