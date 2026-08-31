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
      /must exceed 50 cents/
    );
  });

  it('accepts the first cent above the floor', () => {
    assert.equal(request({ amountCents: MINIMUM_PRINT_CENTS }).amountCents, 51);
  });

  it('refuses a fractional amount', () => {
    assert.throws(() => request({ amountCents: 75.5 }), /integer amount of cents/);
  });
});

describe('video tier', () => {
  it('excludes the video below one euro', () => {
    assert.equal(request({ amountCents: VIDEO_THRESHOLD_CENTS - 1 }).includesVideo, false);
  });

  it('includes the video exactly at one euro', () => {
    assert.equal(request({ amountCents: VIDEO_THRESHOLD_CENTS }).includesVideo, true);
  });
});

describe('PrintJob lifecycle', () => {
  it('runs the happy path and attaches the clip', () => {
    const job = request();
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
    const job = request({ amountCents: 60 });
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
