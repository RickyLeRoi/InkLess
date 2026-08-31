// backend/src/adapters/events/JobEventBus.js

import { EventEmitter } from 'node:events';

/**
 * Per-job status updates pushed to the browser waiting on /job/:id.
 */
export class JobEventBus {
  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
  }

  /**
   * @param {string} jobId
   * @param {object} payload
   */
  publish(jobId, payload) {
    this.emitter.emit(jobId, payload);
  }

  /**
   * @param {string} jobId
   * @param {(payload: object) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(jobId, listener) {
    this.emitter.on(jobId, listener);
    return () => this.emitter.off(jobId, listener);
  }
}
