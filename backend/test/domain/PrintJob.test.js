// backend/test/domain/PrintJob.test.js

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MINIMUM_PRINT_CENTS,
  PrintJob,
  PrintJobStatus,
  VIDEO_THRESHOLD_CENTS
} from '../../src/domain/PrintJob.js';

/** @param {object} [overrides] */
function request(overrides = {}) {
  return PrintJob.request({ messageId: 'msg-1', amountCents: 100, ...overrides });
}

describe('PrintJob.request', () => {
  it('starts awaiting payment', () => {
    assert.equal(request().status, PrintJobStatus.AWAITING_PAYMENT);
  });

  it('refuses a donation at or below the print floor', () => {
    assert.throws(
      () => request({ amountCents: MINIMUM_PRINT_CENTS - 1 }),
      /must exceed 99 cents/
    );
  });

  it('accepts the amount right at the floor', () => {
    assert.equal(request({ amountCents: MINIMUM_PRINT_CENTS }).amountCents, 100);
  });

  it('refuses a fractional amount', () => {
    assert.throws(() => request({ amountCents: 75.5 }), /integer amount of cents/);
  });
});

describe('video tier', () => {
  it('excludes the video below two euros', () => {
    assert.equal(request({ amountCents: VIDEO_THRESHOLD_CENTS - 1 }).includesVideo, false);
  });

  it('includes the video exactly at two euros', () => {
    assert.equal(request({ amountCents: VIDEO_THRESHOLD_CENTS }).includesVideo, true);
  });
});

describe('PrintJob lifecycle', () => {
  it('runs the happy path and attaches the clip', () => {
    const job = request({ amountCents: 200 });
    assert.equal(job.markPaid(), true);
    job.start();
    job.complete('https://r2.example/clip.mp4');
    assert.equal(job.status, PrintJobStatus.COMPLETED);
    assert.equal(job.videoUrl, 'https://r2.example/clip.mp4');
  });

  it('treats a repeated payment confirmation as a no-op', () => {
    const job = request();
    assert.equal(job.markPaid(), true);
    assert.equal(job.markPaid(), false);
    assert.equal(job.status, PrintJobStatus.QUEUED);
  });

  it('refuses a clip for a tier that did not pay for one', () => {
    const job = request({ amountCents: 100 });
    job.markPaid();
    job.start();
    assert.throws(() => job.complete('https://r2.example/clip.mp4'), /did not pay for a video/);
  });

  it('cannot print before the money lands', () => {
    assert.throws(() => request().start(), /Cannot move from "awaiting_payment" to "printing"/);
  });

  it('is final once completed', () => {
    const job = request();
    job.markPaid();
    job.start();
    job.complete();
    assert.throws(() => job.fail('printer jam'), /Cannot move from "completed"/);
  });

  it('records why it failed', () => {
    const job = request();
    job.markPaid();
    job.fail('printer offline');
    assert.equal(job.status, PrintJobStatus.FAILED);
    assert.equal(job.failureReason, 'printer offline');
  });
});

describe('PrintJob.complete rejects a clip URL a browser would execute', () => {
  /** @param {string} url */
  function completeWith(url) {
    const job = PrintJob.request({ messageId: 'msg-1', amountCents: 200 });
    job.markPaid();
    job.start();
    return () => job.complete(url);
  }

  // 20260831 ++ RG #clip_url_must_be_safe
  // The route schema asks AJV for `format: uri`, and "javascript:alert(1)" is a
  // perfectly well-formed URI. It lands in an href and a <video src>, so the scheme
  // is checked where the value becomes part of the job rather than at the edge.
  for (const hostile of [
    'javascript:alert(document.domain)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)'
  ]) {
    it(`refuses ${hostile.split(':')[0]}:`, () => {
      // 20260903 ** RG #assert_the_right_rejection
      // { code: 'VALIDATION_FAILED' } alone doesn't prove which check fired — the
      // tier-vs-video guard in complete() throws the same code, and completeWith's
      // amountCents has to stay in the video tier or this assertion would pass for
      // the wrong reason.
      assert.throws(completeWith(hostile), { code: 'VALIDATION_FAILED', message: /scheme is not allowed/ });
    });
  }

  it('refuses something that is not a URL at all', () => {
    assert.throws(completeWith('non una url'), { code: 'VALIDATION_FAILED', message: /is not a URL/ });
  });

  it('still accepts the http URL the local uploader produces', () => {
    const job = PrintJob.request({ messageId: 'msg-1', amountCents: 200 });
    job.markPaid();
    job.start();
    job.complete('http://127.0.0.1:8080/clips/job-1.mp4');
    assert.equal(job.videoUrl, 'http://127.0.0.1:8080/clips/job-1.mp4');
  });
});
