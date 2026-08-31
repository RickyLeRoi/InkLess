// backend/test/application/EscalateModeration.test.js

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createDatabase } from '../../src/adapters/persistence/database.js';
import { SqliteMessageRepository } from '../../src/adapters/persistence/SqliteMessageRepository.js';
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
  }

  async isAvailable() {
    return this.available;
  }

  /** @param {string} text */
  async evaluate(text) {
    this.seen.push(text);
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
  return new EscalateModeration({ messages: repository, llm, threshold, batchSize: 100 });
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
