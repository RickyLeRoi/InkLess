// backend/test/application/EscalateModeration.test.js

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createDatabase } from '../../src/adapters/persistence/database.js';
import { SqliteMessageRepository } from '../../src/adapters/persistence/SqliteMessageRepository.js';
import { RegexModerationAdapter } from '../../src/adapters/moderation/RegexModerationAdapter.js';
import { EscalateModeration } from '../../src/application/EscalateModeration.js';
import { Message } from '../../src/domain/Message.js';
import { ModerationVerdict } from '../../src/ports/ModerationPort.js';

/** Scripted stand-in for the local model. */
class ScriptedLlm {
  /**
   * @param {(text: string) => import('../../src/ports/ModerationPort.js').ModerationResult} decide
   * @param {boolean} [available]
   */
  constructor(decide, available = true) {
    this.decide = decide;
    this.available = available;
    this.seen = /** @type {string[]} */ ([]);
    this.contexts = /** @type {any[]} */ ([]);
  }

  async isAvailable() {
    return this.available;
  }

  /**
   * @param {string} text
   * @param {{ reasons?: string[], matches?: string[] }} [context]
   */
  async evaluate(text, context) {
    this.seen.push(text);
    this.contexts.push(context ?? { reasons: [], matches: [] });
    return this.decide(text);
  }
}

/**
 * @param {import('../../src/ports/ModerationPort.js').ModerationVerdictValue} verdict
 * @param {string[]} [reasons]
 * @returns {import('../../src/ports/ModerationPort.js').ModerationResult}
 */
function result(verdict, reasons = ['llm:test']) {
  return { verdict, reasons };
}

/** @type {SqliteMessageRepository} */
let repository;

beforeEach(() => {
  repository = new SqliteMessageRepository(createDatabase(':memory:'));
});

/**
 * @param {number} count
 * @param {string} [prefix]
 */
async function seedPending(count, prefix = 'messaggio') {
  for (let index = 0; index < count; index += 1) {
    const message = Message.submit({ text: `${prefix} ${index}`, anonymousSequence: index + 1 });
    await repository.save(message);
  }
}

/**
 * @param {ScriptedLlm} llm
 * @param {number} [threshold]
 */
function escalationFor(llm, threshold = 3) {
  return new EscalateModeration({
    messages: repository,
    moderation: new RegexModerationAdapter(),
    llm,
    threshold,
    batchSize: 100
  });
}

/**
 * @param {string} text
 * @param {'pending' | 'approved'} status
 */
async function seedOne(text, status = 'pending') {
  const message = Message.submit({ text, anonymousSequence: 99 });
  if (status === 'approved') message.approve();
  await repository.save(message);
  return message;
}

describe('threshold', () => {
  it('does nothing while the queue is short', async () => {
    await seedPending(2);
    const llm = new ScriptedLlm(() => result(ModerationVerdict.AUTO_APPROVE));

    const outcome = await escalationFor(llm).runIfNeeded();

    assert.equal(outcome.ran, false);
    assert.equal(outcome.reason, 'below_threshold');
    assert.equal(outcome.pending, 2);
    assert.equal(llm.seen.length, 0);
  });

  it('fires once the queue reaches the threshold', async () => {
    await seedPending(3);
    const llm = new ScriptedLlm(() => result(ModerationVerdict.AUTO_APPROVE));

    const outcome = await escalationFor(llm).runIfNeeded();

    assert.equal(outcome.ran, true);
    assert.equal(outcome.examined, 3);
    assert.equal(llm.seen.length, 3);
  });

  it('skips entirely when no model is reachable', async () => {
    await seedPending(5);
    const llm = new ScriptedLlm(() => result(ModerationVerdict.AUTO_APPROVE), false);

    const outcome = await escalationFor(llm).runIfNeeded();

    assert.equal(outcome.ran, false);
    assert.equal(outcome.reason, 'llm_unavailable');
  });
});

describe('verdicts', () => {
  it('publishes what the model calls safe and bins what it calls unsafe', async () => {
    await seedPending(4);
    const llm = new ScriptedLlm((text) =>
      text.endsWith('0') || text.endsWith('1')
        ? result(ModerationVerdict.AUTO_APPROVE)
        : result(ModerationVerdict.REJECT)
    );

    const outcome = await escalationFor(llm).run();

    assert.equal(outcome.approved, 2);
    assert.equal(outcome.rejected, 2);

    const board = await repository.findApproved({});
    assert.equal(board.total, 2);
  });

  it('leaves the undecided ones pending but flags them for a human', async () => {
    await seedPending(3);
    const llm = new ScriptedLlm(() => result(ModerationVerdict.NEEDS_REVIEW));

    const outcome = await escalationFor(llm).run();

    assert.equal(outcome.keptForHuman, 3);

    const stillPending = await repository.findByStatus('pending');
    assert.equal(stillPending.length, 3);
    assert.ok(stillPending.every((message) => message.needsHuman));
  });
});

describe('the reviewed flag', () => {
  it('never sends the same message to the model twice', async () => {
    await seedPending(3);
    const llm = new ScriptedLlm(() => result(ModerationVerdict.NEEDS_REVIEW));
    const escalation = escalationFor(llm);

    await escalation.run();
    assert.equal(llm.seen.length, 3);

    // A second run, with the queue unchanged, must find nothing left to ask about.
    const second = await escalation.run();
    assert.equal(second.examined, 0);
    assert.equal(llm.seen.length, 3);
  });

  it('picks up newly arrived messages only', async () => {
    await seedPending(3, 'vecchio');
    const llm = new ScriptedLlm(() => result(ModerationVerdict.NEEDS_REVIEW));
    const escalation = escalationFor(llm);
    await escalation.run();

    await seedPending(2, 'nuovo');
    const second = await escalation.run();

    assert.equal(second.examined, 2);
    assert.ok(llm.seen.slice(3).every((text) => text.startsWith('nuovo')));
  });

  /**
   * The distinction that matters: "the model looked and shrugged" is final, while
   * "the model was down" must be retried, or an outage would silently park the whole
   * backlog on the admin.
   */
  it('does not flag a message the model failed to judge', async () => {
    await seedPending(3);
    const llm = new ScriptedLlm(() =>
      result(ModerationVerdict.NEEDS_REVIEW, ['llm_failed:timeout'])
    );
    const escalation = escalationFor(llm);

    const outcome = await escalation.run();
    assert.equal(outcome.retryable, 3);
    assert.equal(outcome.keptForHuman, 0);

    assert.equal(await repository.countAwaitingLlm(), 3);

    const second = await escalation.run();
    assert.equal(second.examined, 3);
  });
});

describe('concurrency', () => {
  it('refuses to start a second run while one is in flight', async () => {
    await seedPending(3);
    /** @type {(value: any) => void} */
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const llm = new ScriptedLlm(() => result(ModerationVerdict.AUTO_APPROVE));
    llm.evaluate = async (text) => {
      llm.seen.push(text);
      await gate;
      return result(ModerationVerdict.AUTO_APPROVE);
    };

    const escalation = escalationFor(llm);
    const first = escalation.run();
    const second = await escalation.run();

    assert.equal(second.ran, false);
    assert.equal(second.reason, 'already_running');

    release(undefined);
    const outcome = await first;
    assert.equal(outcome.examined, 3);
  });
});

describe('what the model is allowed to do', () => {
  /**
   * The regex stage parked this one over a word that is a vegetable half the time.
   * That is a request for a human, and the model does not get to answer it with a bin.
   */
  it('cannot bin a message the regex flagged as ambiguous', async () => {
    const message = await seedOne('che bel finocchio che mi hai venduto');
    const llm = new ScriptedLlm(() => result(ModerationVerdict.REJECT));

    const outcome = await escalationFor(llm).run();

    assert.equal(outcome.rejected, 0);
    assert.equal(outcome.keptForHuman, 1);
    const stored = await repository.findById(message.id);
    assert.equal(stored?.status, 'pending');
    assert.ok(stored?.needsHuman);
  });

  it('still bins a message nothing had flagged', async () => {
    await seedOne('ti aspetto sotto casa, la paghi cara');
    const llm = new ScriptedLlm(() => result(ModerationVerdict.REJECT));

    const outcome = await escalationFor(llm).run();

    assert.equal(outcome.rejected, 1);
  });

  it('clears an ambiguous message when it decides it is harmless', async () => {
    await seedOne('ho comprato un finocchio e due carote');
    const llm = new ScriptedLlm(() => result(ModerationVerdict.AUTO_APPROVE));

    const outcome = await escalationFor(llm).run();

    assert.equal(outcome.approved, 1);
  });

  it('points the model at the word the regex caught', async () => {
    await seedOne('che bel finocchio che mi hai venduto');
    const llm = new ScriptedLlm(() => result(ModerationVerdict.NEEDS_REVIEW));

    await escalationFor(llm).run();

    assert.deepEqual(llm.contexts[0].reasons, ['ambiguous_language']);
    assert.deepEqual(llm.contexts[0].matches, ['finocchio']);
  });
});

describe('the audit of published messages', () => {
  it('looks at what the regex published on its own', async () => {
    await seedOne('ti spacco il record, guarda', 'approved');
    const llm = new ScriptedLlm(() => result(ModerationVerdict.AUTO_APPROVE));

    const outcome = await escalationFor(llm).run();

    assert.equal(outcome.examined, 1);
    // Nothing to approve: it was already on the board.
    assert.equal(outcome.approved, 0);
  });

  it('recalls a published message it finds alarming, without rejecting it', async () => {
    const message = await seedOne('ti aspetto sotto casa, la paghi cara', 'approved');
    const llm = new ScriptedLlm(() => result(ModerationVerdict.REJECT));

    const outcome = await escalationFor(llm).run();

    assert.equal(outcome.recalled, 1);
    assert.equal(outcome.rejected, 0);

    const stored = await repository.findById(message.id);
    assert.equal(stored?.status, 'pending');
    assert.ok(stored?.moderationReasons.includes('llm_takedown'));

    const board = await repository.findApproved({});
    assert.equal(board.total, 0);
  });

  it('leaves a published message alone when it is merely unsure', async () => {
    const message = await seedOne('buon compleanno nonna', 'approved');
    const llm = new ScriptedLlm(() => result(ModerationVerdict.NEEDS_REVIEW));

    await escalationFor(llm).run();

    const stored = await repository.findById(message.id);
    assert.equal(stored?.status, 'approved');
  });

  it('counts published messages towards the threshold', async () => {
    await seedOne('primo', 'approved');
    await seedOne('secondo', 'approved');
    await seedOne('terzo', 'approved');
    const llm = new ScriptedLlm(() => result(ModerationVerdict.AUTO_APPROVE));

    const outcome = await escalationFor(llm).runIfNeeded();

    assert.equal(outcome.ran, true);
    assert.equal(outcome.examined, 3);
  });
});
