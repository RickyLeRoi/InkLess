// backend/src/application/ListBoard.js

export class ListBoard {
  /**
   * @param {object} deps
   * @param {import('../ports/MessageRepository.js').MessageRepository} deps.messages
   */
  constructor({ messages }) {
    this.messages = messages;
  }

  /**
   * @param {import('../ports/MessageRepository.js').BoardQuery} query
   */
  async execute(query) {
    const { items, total } = await this.messages.findApproved(query);
    return {
      items: items.map((message) => message.toPublicJSON()),
      total,
      limit: query.limit ?? items.length,
      offset: query.offset ?? 0
    };
  }

  /**
   * Status lookup for the author returning with ids kept in localStorage.
   *
   * @param {string[]} ids
   */
  async statusOf(ids) {
    const found = await Promise.all(ids.map((id) => this.messages.findById(id)));
    return found
      .filter((message) => message !== null)
      .map((message) => ({ id: message.id, status: message.status }));
  }
}
