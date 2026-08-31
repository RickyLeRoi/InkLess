// backend/test/domain/text.test.js

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MESSAGE_MAX_LENGTH,
  normalizeInstagramHandle,
  normalizeMessageText
} from '../../src/domain/text.js';

describe('normalizeMessageText', () => {
  it('trims and collapses runs of horizontal whitespace', () => {
    assert.equal(normalizeMessageText('  ciao    mondo  '), 'ciao mondo');
  });

  it('removes tag-like sequences', () => {
    assert.equal(
      normalizeMessageText('ciao <script>alert(1)</script> mondo'),
      'ciao alert(1) mondo'
    );
  });

  it('keeps a bare less-than sign', () => {
    assert.equal(normalizeMessageText('3 < 5'), '3 < 5');
  });

  it('drops control characters but keeps newlines', () => {
    const withBell = 'a' + String.fromCharCode(7) + 'b\nc';
    assert.equal(normalizeMessageText(withBell), 'ab\nc');
  });

  it('turns tabs into spaces', () => {
    assert.equal(normalizeMessageText('a\tb'), 'a b');
  });

  it('rejects an empty result', () => {
    assert.throws(() => normalizeMessageText('   '), /cannot be empty/);
  });

  it('rejects text past the limit', () => {
    assert.throws(
      () => normalizeMessageText('x'.repeat(MESSAGE_MAX_LENGTH + 1)),
      /exceeds 200 characters/
    );
  });

  it('accepts text exactly at the limit', () => {
    const text = 'x'.repeat(MESSAGE_MAX_LENGTH);
    assert.equal(normalizeMessageText(text).length, MESSAGE_MAX_LENGTH);
  });

  it('rejects non-string input', () => {
    assert.throws(() => normalizeMessageText(42), /must be a string/);
  });
});

describe('normalizeInstagramHandle', () => {
  it('strips the leading at-sign', () => {
    assert.equal(normalizeInstagramHandle('@ricky.dev'), 'ricky.dev');
  });

  it('treats blank input as absent', () => {
    assert.equal(normalizeInstagramHandle('   '), null);
    assert.equal(normalizeInstagramHandle(undefined), null);
    assert.equal(normalizeInstagramHandle(null), null);
  });

  it('rejects unsupported characters', () => {
    assert.throws(() => normalizeInstagramHandle('ricky dev'), /unsupported characters/);
    assert.throws(() => normalizeInstagramHandle('ricky<b>'), /unsupported characters/);
  });

  it('rejects malformed dot sequences', () => {
    assert.throws(() => normalizeInstagramHandle('.ricky'), /malformed dot/);
    assert.throws(() => normalizeInstagramHandle('ricky.'), /malformed dot/);
    assert.throws(() => normalizeInstagramHandle('ric..ky'), /malformed dot/);
  });

  it('rejects an over-long handle', () => {
    assert.throws(() => normalizeInstagramHandle('a'.repeat(31)), /exceeds 30/);
  });
});
