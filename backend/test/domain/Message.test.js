// backend/test/domain/Message.test.js

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Message, MessageStatus } from '../../src/domain/Message.js';

/** @param {object} [overrides] */
function submit(overrides = {}) {
  return Message.submit({ text: 'ciao mondo', anonymousSequence: 1, ...overrides });
}

describe('Message.submit', () => {
  it('starts pending with a zeroed print counter', () => {
    const message = submit();
    assert.equal(message.status, MessageStatus.PENDING);
    assert.equal(message.printCount, 0);
  });

  it('keeps the submission verbatim alongside the published text', () => {
    const message = submit();
    assert.equal(message.originalText, message.text);
    assert.equal(message.wasCensored, false);
  });

  it('renders a Doe identity when no handle is given', () => {
    assert.equal(submit({ anonymousSequence: 7 }).author, 'Doe#007');
  });

  it('prefers the handle and drops the sequence when both arrive', () => {
    const message = submit({ authorInstagram: '@ricky', anonymousSequence: 5 });
    assert.equal(message.author, '@ricky');
    assert.equal(message.authorSequence, null);
  });

  it('refuses a submission with neither handle nor sequence', () => {
    assert.throws(
      () => Message.submit({ text: 'ciao' }),
      /anonymous sequence is required/
    );
  });
});

describe('Message transitions', () => {
  it('moves pending to approved and back to rejected', () => {
    const message = submit();
    message.approve();
    assert.equal(message.status, MessageStatus.APPROVED);
    message.reject();
    assert.equal(message.status, MessageStatus.REJECTED);
  });

  it('never returns to pending', () => {
    const message = submit();
    message.approve();
    assert.throws(() => message.approve(), /Cannot move from "approved" to "approved"/);
  });

  it('censors while keeping the original for audit', () => {
    const message = submit({ text: 'testo originale' });
    message.censor('testo ***');
    assert.equal(message.text, 'testo ***');
    assert.equal(message.originalText, 'testo originale');
    assert.equal(message.wasCensored, true);
  });

  it('refuses to censor a rejected message', () => {
    const message = submit();
    message.reject();
    assert.throws(() => message.censor('qualsiasi'), /Cannot move from "rejected"/);
  });
});

describe('Message.registerPrint', () => {
  it('increments only for a published message', () => {
    const message = submit();
    message.approve();
    message.registerPrint();
    message.registerPrint();
    assert.equal(message.printCount, 2);
  });

  it('refuses to count a print for something not on the board', () => {
    assert.throws(() => submit().registerPrint(), /Cannot move from "pending" to "printed"/);
  });
});
