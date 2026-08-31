// backend/src/adapters/queue/InProcessPrintQueue.js

import { EventEmitter } from 'node:events';

/**
 * Fan-out towards whichever hardware node is currently listening.
 *
 * 20260830 ++ RG #offline_hardware
 * Publishing is best-effort on purpose: the print_jobs table is the source of truth,
 * so a ticket emitted while the RPi is offline is not lost — the daemon replays every
 * job still in "queued" when it reconnects. Buffering here would only duplicate that.
 *
 * Satisfies the PrintQueuePort contract.
 */
export class InProcessPrintQueue {
  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
  }

  /** @param {import('../../ports/PrintQueuePort.js').PrintTicket} ticket */
  async publish(ticket) {
    this.emitter.emit('ticket', ticket);
  }

  /** @returns {Promise<boolean>} */
  async isHardwareOnline() {
    return this.emitter.listenerCount('ticket') > 0;
  }

  /**
   * @param {(ticket: import('../../ports/PrintQueuePort.js').PrintTicket) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(listener) {
    this.emitter.on('ticket', listener);
    return () => this.emitter.off('ticket', listener);
  }
}
