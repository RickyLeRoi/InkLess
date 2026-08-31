// backend/test/adapters/SqliteMessageRepository.test.js

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createDatabase } from '../../src/adapters/persistence/database.js';
import { SqliteMessageRepository } from '../../src/adapters/persistence/SqliteMessageRepository.js';
import { Message } from '../../src/domain/Message.js';

/** @type {SqliteMessageRepository} */
let repository;

beforeEach(() => {
  repository = new SqliteMessageRepository(createDatabase(':memory:'));
});

/** @param {object} [overrides] */
async function saveApproved(overrides = {}) {
  const message = Message.submit({ text: 'ciao mondo', anonymousSequence: 1, ...overrides });
  message.approve();
  await repository.save(message);
  return message;
}

describe('SqliteMessageRepository', () => {
  it('round-trips a message through storage', async () => {
    const saved = await saveApproved({ authorInstagram: 'ricky', anonymousSequence: null });
    const loaded = await repository.findById(saved.id);

    assert.ok(loaded);
    assert.equal(loaded.text, saved.text);
    assert.equal(loaded.authorInstagram, 'ricky');
    assert.equal(loaded.author, '@ricky');
    assert.equal(loaded.createdAt.toISOString(), saved.createdAt.toISOString());
  });

  it('returns null for an unknown id', async () => {
    assert.equal(await repository.findById('nope'), null);
  });

  it('persists updates rather than duplicating rows', async () => {
    const message = await saveApproved();
    message.registerPrint();
    await repository.save(message);

    const loaded = await repository.findById(message.id);
    assert.equal(loaded?.printCount, 1);
    const { total } = await repository.findApproved({});
    assert.equal(total, 1);
  });

  it('shows only approved messages on the board', async () => {
    await saveApproved();
    const pending = Message.submit({ text: 'in attesa', anonymousSequence: 2 });
    await repository.save(pending);

    const { items, total } = await repository.findApproved({});
    assert.equal(total, 1);
    assert.equal(items.length, 1);
  });

  it('searches body and author together', async () => {
    await saveApproved({ text: 'messaggio sulla pizza' });
    await saveApproved({ text: 'altro testo', authorInstagram: 'pizzaiolo', anonymousSequence: null });
    await saveApproved({ text: 'niente di rilevante' });

    const { total } = await repository.findApproved({ search: 'pizza' });
    assert.equal(total, 2);
  });

  it('treats LIKE wildcards in the query as literal characters', async () => {
    await saveApproved({ text: 'testo senza percentuali' });
    const { total } = await repository.findApproved({ search: '%' });
    assert.equal(total, 0);
  });

  it('paginates newest first', async () => {
    await saveApproved({ text: 'primo', now: new Date('2026-01-01T00:00:00.000Z') });
    await saveApproved({ text: 'secondo', now: new Date('2026-06-01T00:00:00.000Z') });

    const page = await repository.findApproved({ limit: 1, offset: 0 });
    assert.equal(page.items[0].text, 'secondo');
    assert.equal(page.total, 2);
  });

  it('hands out a fresh anonymous sequence every call', async () => {
    const first = await repository.nextAnonymousSequence();
    const second = await repository.nextAnonymousSequence();
    assert.equal(first, 1);
    assert.equal(second, 2);
  });

  it('rejects a row carrying both identities', async () => {
    const message = await saveApproved();
    message.authorInstagram = 'ricky';
    await assert.rejects(() => repository.save(message));
  });
});
