// backend/test/http/adminModeration.test.js

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { composeApp } from '../../src/composition.js';
import { loadConfig } from '../../src/config/env.js';
import { buildServer } from '../../src/http/server.js';

/** @type {any} */
let app;
/** @type {import('fastify').FastifyInstance} */
let server;

const ADMIN = { authorization: `Basic ${Buffer.from('admin:inkless-dev').toString('base64')}` };

beforeEach(async () => {
  const config = { ...loadConfig(), databasePath: ':memory:' };
  app = composeApp(config);
  server = await buildServer(app);
});

afterEach(async () => {
  await server.close();
});

/** @param {object} body */
async function submit(body) {
  return (await server.inject({ method: 'POST', url: '/api/messages', payload: body })).json();
}

/** @param {string} status */
async function queue(status = 'pending') {
  const response = await server.inject({
    method: 'GET',
    url: `/api/admin/messages?status=${status}`,
    headers: ADMIN
  });
  return response.json().items;
}

describe('a handle never rejects on its own', () => {
  it('sends an offensive handle to review instead of binning the message', async () => {
    const created = await submit({ text: 'Buon compleanno nonna!', authorInstagram: '@porcodio90' });

    assert.equal(created.status, 'pending');
    assert.equal(created.moderation.verdict, 'needs_review');
    assert.ok(created.moderation.reasons.includes('handle_blasphemy'));
  });

  it('still rejects when the body itself is the problem', async () => {
    const created = await submit({ text: 'sei un frocio', authorInstagram: '@ricky' });
    assert.equal(created.status, 'rejected');
  });

  it('surfaces the reasons to the admin queue', async () => {
    await submit({ text: 'Ciao a tutti', authorInstagram: '@ilfrociodelsud' });

    const [item] = await queue();
    assert.ok(item.moderationReasons.includes('handle_hate_speech'));
    assert.equal(item.authorInstagram, 'ilfrociodelsud');
  });
});

describe('the panel censors, it does not rewrite', () => {
  it('blacks out the handle and publishes, keeping the real one on the row', async () => {
    await submit({ text: 'Ciao a tutti', authorInstagram: '@ilfrociodelsud' });
    const [item] = await queue();

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/admin/messages/${item.id}`,
      headers: ADMIN,
      payload: { censorHandle: true, approve: true }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().author, '@i************d');

    const board = await server.inject({ method: 'GET', url: '/api/messages' });
    assert.equal(board.json().items[0].author, '@i************d');

    // The verbatim handle stays in the row: it is what the toggle puts back, and the
    // profile link is still the real one.
    const stored = await app.messages.findById(item.id);
    assert.equal(stored.authorInstagram, 'ilfrociodelsud');
  });

  it('puts the handle back when the toggle goes off', async () => {
    await submit({ text: 'Ciao a tutti', authorInstagram: '@ilfrociodelsud' });
    const [item] = await queue();

    await server.inject({
      method: 'PATCH',
      url: `/api/admin/messages/${item.id}`,
      headers: ADMIN,
      payload: { censorHandle: true, approve: true }
    });
    const response = await server.inject({
      method: 'PATCH',
      url: `/api/admin/messages/${item.id}`,
      headers: ADMIN,
      payload: { censorHandle: false }
    });

    assert.equal(response.json().author, '@ilfrociodelsud');
  });

  it('blacks out body and handle in one call', async () => {
    await submit({ text: 'chiamami al 333 444 5566', authorInstagram: '@figadilegno' });
    const [item] = await queue();

    // Word indices come from the queue itself, which is where the panel reads them.
    assert.deepEqual(
      item.words.map(/** @param {any} word */ (word) => word.word),
      ['chiamami', 'al', '333', '444', '5566']
    );

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/admin/messages/${item.id}`,
      headers: ADMIN,
      payload: { censoredWords: [2, 3, 4], censorHandle: true, approve: true }
    });

    const body = response.json();
    assert.equal(body.text, 'chiamami al 3*3 4*4 5**6');
    assert.equal(body.author, '@f*********o');
    assert.equal(body.status, 'approved');
  });

  it('reports the toggle state back to the panel', async () => {
    await submit({ text: 'chiamami al 333 444 5566' });
    const [before] = await queue();
    assert.equal(before.handEdited, false);
    assert.equal(before.handleCensored, false);

    await server.inject({
      method: 'PATCH',
      url: `/api/admin/messages/${before.id}`,
      headers: ADMIN,
      payload: { censoredWords: [0] }
    });

    const [after] = await queue();
    assert.equal(after.words[0].censored, true);
    assert.equal(after.words[1].censorable, false);
  });

  it('has no way left to publish text nobody wrote', async () => {
    await submit({ text: 'chiamami al 333 444 5566' });
    const [item] = await queue();

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/admin/messages/${item.id}`,
      headers: ADMIN,
      payload: { text: 'tutta un altra cosa', approve: true }
    });

    assert.equal(response.statusCode, 400);
  });

  it('refuses an empty patch', async () => {
    await submit({ text: 'chiamami al 333 444 5566' });
    const [item] = await queue();

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/admin/messages/${item.id}`,
      headers: ADMIN,
      payload: {}
    });

    assert.equal(response.statusCode, 400);
  });

  /** The appeal path: rejected, blacked out, published, in a single call. */
  it('censors and publishes a rejected message', async () => {
    const created = await submit({ text: 'sei un frocio' });
    assert.equal(created.status, 'rejected');

    const [item] = await queue('rejected');
    const response = await server.inject({
      method: 'PATCH',
      url: `/api/admin/messages/${item.id}`,
      headers: ADMIN,
      payload: { censoredWords: [2], approve: true }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().text, 'sei un f****o');
    assert.equal(response.json().status, 'approved');
  });
});

describe('takedown from the board', () => {
  it('removes a message the automatic pass let through', async () => {
    const created = await submit({ text: 'Un messaggio perfettamente innocuo' });
    assert.equal(created.status, 'approved');

    const before = await server.inject({ method: 'GET', url: '/api/messages' });
    assert.equal(before.json().total, 1);

    const response = await server.inject({
      method: 'POST',
      url: `/api/admin/messages/${created.id}/takedown`,
      headers: ADMIN
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'rejected');

    const after = await server.inject({ method: 'GET', url: '/api/messages' });
    assert.equal(after.json().total, 0);
  });

  it('is closed to anonymous callers', async () => {
    const created = await submit({ text: 'Un messaggio perfettamente innocuo' });

    const response = await server.inject({
      method: 'POST',
      url: `/api/admin/messages/${created.id}/takedown`
    });

    assert.equal(response.statusCode, 401);

    const board = await server.inject({ method: 'GET', url: '/api/messages' });
    assert.equal(board.json().total, 1);
  });

  /**
   * A takedown is a status change, never a DELETE: print_jobs cascade on delete and
   * would take the record of paid prints with them.
   */
  it('keeps the paid print history intact', async () => {
    const created = await submit({ text: 'Un messaggio perfettamente innocuo' });
    const { jobId } = (
      await server.inject({
        method: 'POST',
        url: `/api/messages/${created.id}/print`,
        payload: { amountCents: 100 }
      })
    ).json();

    await server.inject({
      method: 'POST',
      url: `/api/admin/messages/${created.id}/takedown`,
      headers: ADMIN
    });

    const job = await app.jobs.findById(jobId);
    assert.ok(job);
    assert.equal(job.messageId, created.id);
  });
});
