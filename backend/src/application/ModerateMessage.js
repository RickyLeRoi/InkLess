// backend/src/application/ModerateMessage.js

import { NotFoundError } from '../domain/errors.js';
import { normalizeInstagramHandle } from '../domain/text.js';

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
   * Edits the published body, the author handle, or both.
   *
   * @param {string} id
   * @param {object} changes
   * @param {unknown} [changes.text]
   * @param {string | null} [changes.authorInstagram] null anonymises the author
   * @param {boolean} [changes.approve] publish it in the same move
   */
  async censor(id, changes) {
    const message = await this.#load(id);

    if (changes.text !== undefined) {
      message.censor(changes.text);
    }

    if (changes.authorInstagram !== undefined) {
      const handle = normalizeInstagramHandle(changes.authorInstagram);
      // Blanking the handle still has to leave an identity behind, so a fresh Doe
      // number is drawn rather than leaving the row with neither.
      const sequence = handle ? null : await this.messages.nextAnonymousSequence();
      message.censorHandle(handle, sequence);
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
