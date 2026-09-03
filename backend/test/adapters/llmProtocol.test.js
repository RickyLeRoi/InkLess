// backend/test/adapters/llmProtocol.test.js

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
  describeFailure,
  parseVerdict
} from '../../src/adapters/moderation/llmProtocol.js';
import { ModerationVerdict } from '../../src/ports/ModerationPort.js';

describe('the response contract', () => {
  /**
   * The ordering is the fix, not a detail: a verdict sampled before the reasoning is a
   * verdict picked off the most alarming word in the message.
   */
  it('asks for the reasoning before the verdict', () => {
    assert.deepEqual(Object.keys(RESPONSE_SCHEMA.properties), ['reasoning', 'verdict']);
    assert.ok(SYSTEM_PROMPT.indexOf('"reasoning"') < SYSTEM_PROMPT.indexOf('"verdict"'));
  });

  it('offers the model a way to say it does not know', () => {
    assert.ok(RESPONSE_SCHEMA.properties.verdict.enum.includes('unsure'));
  });

  it('never uses a golden-set message as an example', () => {
    const golden = ['finocchio che mi hai venduto', 'tua sorella', 'ti aspetto sotto casa'];
    for (const text of golden) assert.ok(!SYSTEM_PROMPT.includes(text), text);
  });
});

describe('parseVerdict', () => {
  it('reads a verdict and keeps the reasoning for the admin panel', () => {
    const result = parseVerdict('{"reasoning":"Recipe context, no target.","verdict":"safe"}');
    assert.equal(result.verdict, ModerationVerdict.AUTO_APPROVE);
    assert.deepEqual(result.reasons, ['llm:Recipe context, no target.']);
  });

  it('maps unsure to the admin queue', () => {
    const result = parseVerdict('{"reasoning":"Banter or attack, unclear.","verdict":"unsure"}');
    assert.equal(result.verdict, ModerationVerdict.NEEDS_REVIEW);
  });

  it('still understands the older reason key', () => {
    const result = parseVerdict('{"verdict":"unsafe","reason":"threat"}');
    assert.equal(result.verdict, ModerationVerdict.REJECT);
    assert.deepEqual(result.reasons, ['llm:threat']);
  });

  it('falls back to a plain label when the model explains nothing', () => {
    assert.deepEqual(parseVerdict('{"verdict":"safe","reasoning":"  "}').reasons, ['llm:llm']);
  });

  it('truncates a model that will not shut up', () => {
    const result = parseVerdict(`{"reasoning":"${'parola '.repeat(40)}","verdict":"safe"}`);
    assert.equal(result.reasons[0].length, 'llm:'.length + 80);
  });

  /**
   * Every unreadable answer is a judgement the model never delivered, and those must
   * stay retryable: flagging them would park an outage on the admin.
   */
  it('treats an unusable answer as undelivered rather than as a doubt', () => {
    for (const content of ['', 'sure thing!', '{"verdict":"maybe"}', '{}', null]) {
      const result = parseVerdict(content);
      assert.equal(result.verdict, ModerationVerdict.NEEDS_REVIEW);
      assert.ok(result.reasons[0].startsWith('llm_failed:'), String(content));
    }
  });

  it('separates a timeout from an unreachable host', () => {
    const timeout = new Error('too slow');
    timeout.name = 'TimeoutError';
    assert.deepEqual(describeFailure(timeout).reasons, ['llm_failed:timeout']);
    assert.deepEqual(describeFailure(new Error('ECONNREFUSED')).reasons, ['llm_failed:unreachable']);
  });
});
