// backend/src/application/ModerateMessage.js

import { NotFoundError } from '../domain/errors.js';

export class ModerateMessage {
  /**
   * @param {object} deps
   * @param {import('../ports/MessageRepository.js').MessageRepository} deps.messages
   */
  constructor({ messages }) {
    this.messages = messages;
  }

  /**
   * @param {string} id
   * @returns {Promise<import('../domain/Message.js').Message>}
   */
  async #load(id) {
    const message = await this.messages.findById(id);
    if (!message) throw new NotFoundError('Message', id);
    return message;
  }

  /** @param {string} id */
  async approve(id) {
    const message = await this.#load(id);
    message.approve();
    await this.messages.save(message);
    return message;
  }

  /** @param {string} id */
  async reject(id) {
    const message = await this.#load(id);
    message.reject();
    await this.messages.save(message);
    return message;
  }

  /**
   * Blacks out words of the body, the author's handle, or both, and optionally
   * publishes in the same move.
   *
   * The caller sends the complete set of censored words every time rather than a
   * delta, so the call is idempotent and lifting a censorship needs no operation of
   * its own. Censorship runs before the approval: the appeal path is reject → black
   * out → publish, and doing it the other way round would put the message on the
   * board in the clear for as long as the two calls are apart.
   *
   * @param {string} id
   * @param {object} changes
   * @param {number[]} [changes.censoredWords] the full set, not a delta
   * @param {boolean} [changes.censorHandle]
   * @param {boolean} [changes.approve] publish it in the same move
   */
  async censor(id, changes) {
    const message = await this.#load(id);

    if (changes.censoredWords !== undefined) {
      message.censorWords(changes.censoredWords);
    }

    if (changes.censorHandle !== undefined) {
      message.setHandleCensored(changes.censorHandle);
    }

    if (changes.approve && !message.isPublished) message.approve();

    await this.messages.save(message);
    return message;
  }

  /**
   * A rejected author asking for a second reading. Public: the caller holds the id
   * because they submitted the message, which is the only claim anyone has here.
   *
   * @param {string} id
   */
  async requestAppeal(id) {
    const message = await this.#load(id);
    if (message.requestAppeal()) await this.messages.save(message);
    return message;
  }

  /**
   * Pulls a published message off the board.
   *
   * 20260831 ++ RG #takedown_not_delete
   * This is a status change, not a DELETE. Print jobs reference messages with ON
   * DELETE CASCADE, so removing the row would also erase the record of prints people
   * actually paid for. The board only shows approved messages, so rejecting is enough
   * to make it disappear.
   *
   * @param {string} id
   */
  async takeDown(id) {
    return this.reject(id);
  }

  /** @param {string} status */
  async listByStatus(status) {
    return this.messages.findByStatus(status);
  }
}
