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

  it('blacks out a word while keeping the original for audit', () => {
    const message = submit({ text: 'testo cazzuto originale' });
    message.censorWords([1]);
    assert.equal(message.text, 'testo c*****o originale');
    assert.equal(message.originalText, 'testo cazzuto originale');
    assert.equal(message.wasCensored, true);
    assert.deepEqual(message.censoredWords, [1]);
  });

  it('lifts a censorship when the same set arrives without that word', () => {
    const message = submit({ text: 'testo cazzuto originale' });
    message.censorWords([0, 1]);
    message.censorWords([0]);
    assert.equal(message.text, 't***o cazzuto originale');
    assert.deepEqual(message.censoredWords, [0]);
  });

  it('censors a rejected message, so an appeal can be published in one move', () => {
    const message = submit({ text: 'testo cazzuto originale' });
    message.reject();
    message.censorWords([1]);
    message.approve();
    assert.equal(message.text, 'testo c*****o originale');
    assert.equal(message.status, MessageStatus.APPROVED);
  });

  it('masks the author on demand and puts it back', () => {
    const message = submit({ authorInstagram: '@bastardo' });
    message.setHandleCensored(true);
    assert.equal(message.author, '@b******o');
    assert.equal(message.authorInstagram, 'bastardo');
    message.setHandleCensored(false);
    assert.equal(message.author, '@bastardo');
  });

  it('masks a Doe identity too', () => {
    const message = submit({ anonymousSequence: 1 });
    message.setHandleCensored(true);
    assert.equal(message.author, 'D*****1');
  });

  it('flags a body no censorship could have produced', () => {
    const message = submit({ text: 'testo cazzuto originale' });
    assert.equal(message.handEdited, false);
    // What the old free-text panel used to leave behind.
    message.text = 'tutt altro testo';
    assert.equal(message.handEdited, true);
    assert.deepEqual(message.censoredWords, []);
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
