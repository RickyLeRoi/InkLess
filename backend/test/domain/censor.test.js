// backend/test/domain/censor.test.js

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyCensorship,
  describeWords,
  maskWord,
  normalizeWordIndices,
  readCensorship,
  tokenizeWords
} from '../../src/domain/censor.js';

describe('maskWord', () => {
  it('keeps the first and last letter in the clear', () => {
    assert.equal(maskWord('cazzo'), 'c***o');
  });

  it('leaves a word with no interior alone', () => {
    assert.equal(maskWord('di'), 'di');
    assert.equal(maskWord('a'), 'a');
  });

  it('masks the shortest word that has an interior', () => {
    assert.equal(maskWord('dio'), 'd*o');
  });

  it('keeps the exact length, accents included', () => {
    assert.equal(maskWord('perché').length, 'perché'.length);
  });
});

describe('tokenizeWords', () => {
  it('leaves punctuation out of the word', () => {
    const [word] = tokenizeWords('cazzo!');
    assert.equal(word.word, 'cazzo');
    assert.equal(word.end, 5);
  });

  it('splits on an apostrophe, so only the offensive half is maskable', () => {
    assert.deepEqual(
      tokenizeWords("dell'idiota").map((word) => word.word),
      ['dell', 'idiota']
    );
  });

  it('marks a word with no interior as not censorable', () => {
    const [di, cane] = tokenizeWords('di cane');
    assert.equal(di.censorable, false);
    assert.equal(cane.censorable, true);
  });
});

describe('applyCensorship', () => {
  it('masks only the words asked for', () => {
    assert.equal(applyCensorship('vaffanculo a tutti quanti', [0]), 'v********o a tutti quanti');
  });

  it('keeps punctuation and spacing untouched', () => {
    assert.equal(applyCensorship('ciao, stronzo!', [1]), 'ciao, s*****o!');
  });

  it('ignores an index that has nothing to mask', () => {
    assert.equal(applyCensorship('di cane', [0]), 'di cane');
  });

  it('is a pure function of the original, so it never stacks', () => {
    const once = applyCensorship('vaffanculo a tutti', [0]);
    assert.equal(applyCensorship('vaffanculo a tutti', [0]), once);
  });
});

describe('readCensorship', () => {
  it('reads back the words that were masked', () => {
    const original = 'vaffanculo a tutti quanti';
    assert.deepEqual(readCensorship(original, applyCensorship(original, [0, 3])), [0, 3]);
  });

  it('reports nothing for an untouched text', () => {
    assert.deepEqual(readCensorship('ciao mondo', 'ciao mondo'), []);
  });

  /**
   * The whole reversibility of the toggle rests on this: a body rewritten by hand is
   * not a censorship, and pretending otherwise would show the admin a set of stars
   * they never clicked.
   */
  it('refuses a body that no set of censored words could produce', () => {
    assert.equal(readCensorship('ciao mondo', 'altro testo'), null);
    assert.equal(readCensorship('ciao mondo', 'ciao'), null);
    assert.equal(readCensorship('ciao mondo', 'ciao*mondo'), null);
  });
});

describe('describeWords', () => {
  it('hands the panel a toggle state per word', () => {
    const original = 'ciao stronzo';
    assert.deepEqual(describeWords(original, applyCensorship(original, [1])), [
      { index: 0, start: 0, end: 4, word: 'ciao', censored: false, censorable: true },
      { index: 1, start: 5, end: 12, word: 'stronzo', censored: true, censorable: true }
    ]);
  });

  it('shows a hand-edited body as fully uncensored', () => {
    const words = describeWords('ciao mondo', 'tutto altro');
    assert.deepEqual(
      words.map((word) => word.censored),
      [false, false]
    );
  });
});

describe('normalizeWordIndices', () => {
  it('dedupes and sorts', () => {
    assert.deepEqual(normalizeWordIndices([3, 1, 1]), [1, 3]);
  });

  it('refuses anything that is not a word position', () => {
    assert.throws(() => normalizeWordIndices('1'), /array of indices/);
    assert.throws(() => normalizeWordIndices([-1]), /non-negative integer/);
    assert.throws(() => normalizeWordIndices([1.5]), /non-negative integer/);
  });
});
