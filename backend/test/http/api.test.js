// backend/test/http/api.test.js

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { composeApp } from '../../src/composition.js';
import { loadConfig } from '../../src/config/env.js';
import { buildServer } from '../../src/http/server.js';

/** @type {any} */
let app;
/** @type {import('fastify').FastifyInstance} */
let server;

const ADMIN_AUTH = `Basic ${Buffer.from('admin:inkless-dev').toString('base64')}`;
const HARDWARE_AUTH = 'Bearer inkless-dev-hardware';

beforeEach(async () => {
  const config = { ...loadConfig(), databasePath: ':memory:' };
  app = composeApp(config);
  server = await buildServer(app);
});

afterEach(async () => {
  await server.close();
});

/** @param {object} [body] */
async function submit(body = { text: 'un messaggio innocuo' }) {
  return server.inject({ method: 'POST', url: '/api/messages', payload: body });
}

describe('POST /api/messages', () => {
  it('accepts and publishes an innocuous message', async () => {
    const response = await submit();
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.status, 'approved');
    assert.equal(body.author, 'Doe#001');
  });

  it('refuses text past 200 characters at the schema boundary', async () => {
    const response = await submit({ text: 'x'.repeat(201) });
    assert.equal(response.statusCode, 400);
  });

  /**
   * 20260902 ** RG #show_the_words
   * The word we bin, not the disguise it arrived in: "C0GL10NE" comes back as
   * "coglione". Self-explanatory, and it does not double as a report on which
   * obfuscations the filter can see through.
   */
  it('reports the blocked word behind the disguise', async () => {
    const response = await submit({ text: 'sei un C0GL10NE' });
    const body = response.json();
    assert.equal(body.status, 'rejected');
    assert.deepEqual(body.moderation.matches, ['coglione']);
  });

  it('reports nothing when nothing fired', async () => {
    assert.deepEqual((await submit()).json().moderation.matches, []);
  });

  it('refuses unknown properties', async () => {
    const response = await submit({ text: 'ciao', isAdmin: true });
    assert.equal(response.statusCode, 400);
  });

  it('refuses a malformed handle', async () => {
    const response = await submit({ text: 'ciao', authorInstagram: 'non valido!' });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'VALIDATION_FAILED');
  });

  it('throttles a flood from the same address', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const allowed = await submit({ text: `messaggio numero ${attempt}` });
      assert.equal(allowed.statusCode, 201);
    }
    const blocked = await submit({ text: 'uno di troppo' });
    assert.equal(blocked.statusCode, 429);
  });
});

describe('GET /api/messages', () => {
  it('lists only what has been approved', async () => {
    await submit({ text: 'messaggio pulito' });
    await submit({ text: 'chiamami al 333 444 5566' });

    const response = await server.inject({ method: 'GET', url: '/api/messages' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.total, 1);
    assert.equal(body.items[0].text, 'messaggio pulito');
  });

  it('reports status for ids kept in localStorage', async () => {
    const created = (await submit()).json();
    const response = await server.inject({
      method: 'GET',
      url: `/api/messages/status?ids=${created.id},inesistente`
    });
    assert.deepEqual(response.json().items, [
      { id: created.id, status: 'approved', excerpt: 'un messaggio innocuo', appealed: false }
    ]);
  });

  it('shortens the excerpt so a long list stays readable', async () => {
    const created = (await submit({ text: 'uno due tre quattro cinque sei' })).json();
    const response = await server.inject({
      method: 'GET',
      url: `/api/messages/status?ids=${created.id}`
    });
    assert.equal(response.json().items[0].excerpt, 'uno due tre quattro...');
  });
});

describe('POST /api/messages/:id/appeal', () => {
  it('puts a rejected message back in front of a human', async () => {
    const rejected = (await submit({ text: 'sei un coglione' })).json();
    assert.equal(rejected.status, 'rejected');

    const response = await server.inject({
      method: 'POST',
      url: `/api/messages/${rejected.id}/appeal`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().appealed, true);

    const queue = await server.inject({
      method: 'GET',
      url: '/api/admin/messages?status=rejected',
      headers: { authorization: ADMIN_AUTH }
    });
    const item = queue.json().items.find(/** @param {any} row */ (row) => row.id === rejected.id);
    assert.equal(item.appealRequested, true);
  });

  it('does not stack a second appeal on the same message', async () => {
    const rejected = (await submit({ text: 'sei un coglione' })).json();
    const url = `/api/messages/${rejected.id}/appeal`;

    await server.inject({ method: 'POST', url });
    const again = await server.inject({ method: 'POST', url });
    assert.equal(again.statusCode, 200);

    const status = await server.inject({
      method: 'GET',
      url: `/api/messages/status?ids=${rejected.id}`
    });
    assert.equal(status.json().items[0].appealed, true);
  });

  it('refuses an appeal against something that was not rejected', async () => {
    const approved = (await submit()).json();
    const response = await server.inject({
      method: 'POST',
      url: `/api/messages/${approved.id}/appeal`
    });
    assert.equal(response.statusCode, 409);
  });
});

describe('GET /api/messages/:id', () => {
  it('serves a single published message for a shared link', async () => {
    const created = (await submit({ text: 'messaggio linkabile' })).json();
    const response = await server.inject({ method: 'GET', url: `/api/messages/${created.id}` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().text, 'messaggio linkabile');
  });

  it('hides anything the board does not show', async () => {
    const pending = (await submit({ text: 'chiamami al 333 444 5566' })).json();
    assert.equal(pending.status, 'pending');

    const response = await server.inject({ method: 'GET', url: `/api/messages/${pending.id}` });
    assert.equal(response.statusCode, 404);
  });

  it('answers 404 for an unknown id', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/messages/inesistente' });
    assert.equal(response.statusCode, 404);
  });
});

describe('admin surface', () => {
  it('refuses anonymous access', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/admin/messages' });
    assert.equal(response.statusCode, 401);
  });

  it('refuses wrong credentials', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/admin/messages',
      headers: { authorization: `Basic ${Buffer.from('admin:sbagliata').toString('base64')}` }
    });
    assert.equal(response.statusCode, 401);
  });

  it('lists the queue awaiting a human', async () => {
    await submit({ text: 'chiamami al 333 444 5566' });
    const response = await server.inject({
      method: 'GET',
      url: '/api/admin/messages?status=pending',
      headers: { authorization: ADMIN_AUTH }
    });
    assert.equal(response.json().items.length, 1);
  });

  it('censors and publishes in one move, keeping the original', async () => {
    await submit({ text: 'chiamami al 333 444 5566' });
    const pending = (
      await server.inject({
        method: 'GET',
        url: '/api/admin/messages?status=pending',
        headers: { authorization: ADMIN_AUTH }
      })
    ).json().items[0];

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/admin/messages/${pending.id}`,
      headers: { authorization: ADMIN_AUTH },
      payload: { censoredWords: [2, 3, 4], approve: true }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'approved');

    const stored = await app.messages.findById(pending.id);
    assert.equal(stored.originalText, 'chiamami al 333 444 5566');
    assert.equal(stored.text, 'chiamami al 3*3 4*4 5**6');
    assert.equal(stored.wasCensored, true);
  });

  it('reports an illegal transition as a conflict', async () => {
    const created = (await submit()).json();
    const response = await server.inject({
      method: 'POST',
      url: `/api/admin/messages/${created.id}/approve`,
      headers: { authorization: ADMIN_AUTH }
    });
    assert.equal(response.statusCode, 409);
  });

  it('reports a missing message as not found', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/admin/messages/inesistente/approve',
      headers: { authorization: ADMIN_AUTH }
    });
    assert.equal(response.statusCode, 404);
  });
});

describe('print and payment over HTTP', () => {
  it('walks from board to completed print', async () => {
    const created = (await submit({ text: 'stampami', authorInstagram: '@autore' })).json();

    const booked = await server.inject({
      method: 'POST',
      url: `/api/messages/${created.id}/print`,
      payload: { amountCents: 100, printerInstagram: '@stampatore' }
    });
    assert.equal(booked.statusCode, 201);
    const { jobId, redirectUrl } = booked.json();
    assert.ok(redirectUrl.includes(jobId));

    const job = await app.jobs.findById(jobId);
    const paid = await server.inject({
      method: 'POST',
      url: '/api/payments/callback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ paymentRef: job.paymentRef, paid: true })
    });
    assert.equal(paid.json().queued, true);

    await server.inject({
      method: 'POST',
      url: `/internal/jobs/${jobId}/start`,
      headers: { authorization: HARDWARE_AUTH }
    });
    const done = await server.inject({
      method: 'POST',
      url: `/internal/jobs/${jobId}/complete`,
      headers: { authorization: HARDWARE_AUTH },
      payload: { videoUrl: 'https://r2.test/clip.mp4' }
    });
    assert.equal(done.json().status, 'completed');

    const board = await server.inject({ method: 'GET', url: '/api/messages' });
    assert.equal(board.json().items[0].printCount, 1);
  });

  it('refuses a donation at or below the floor', async () => {
    const created = (await submit()).json();
    const response = await server.inject({
      method: 'POST',
      url: `/api/messages/${created.id}/print`,
      payload: { amountCents: 50 }
    });
    assert.equal(response.statusCode, 400);
  });
});

describe('hardware surface', () => {
  it('refuses a missing or wrong token', async () => {
    const anonymous = await server.inject({ method: 'GET', url: '/internal/jobs/queued' });
    assert.equal(anonymous.statusCode, 401);

    const wrong = await server.inject({
      method: 'GET',
      url: '/internal/jobs/queued',
      headers: { authorization: 'Bearer sbagliato' }
    });
    assert.equal(wrong.statusCode, 401);
  });

  it('replays jobs that were paid while the printer was offline', async () => {
    const created = (await submit({ text: 'stampami', authorInstagram: '@autore' })).json();
    const { jobId } = (
      await server.inject({
        method: 'POST',
        url: `/api/messages/${created.id}/print`,
        payload: { amountCents: 60 }
      })
    ).json();

    const job = await app.jobs.findById(jobId);
    await server.inject({
      method: 'POST',
      url: '/api/payments/callback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ paymentRef: job.paymentRef, paid: true })
    });

    const catchUp = await server.inject({
      method: 'GET',
      url: '/internal/jobs/queued',
      headers: { authorization: HARDWARE_AUTH }
    });
    const items = catchUp.json().items;
    assert.equal(items.length, 1);
    assert.equal(items[0].attribution, 'Scritto e stampato da: @autore');
    assert.equal(items[0].includesVideo, false);
  });
});

describe('GET /health', () => {
  it('answers without authentication', async () => {
    const response = await server.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ok');
  });
});
