// backend/src/application/ListBoard.js

import { NotFoundError } from '../domain/errors.js';

/** Enough words for an author to recognise which of their messages a row is. */
const EXCERPT_WORDS = 4;

/**
 * @param {string} text
 * @returns {string}
 */
function excerptOf(text) {
  const words = text.trim().split(/\s+/);
  if (words.length <= EXCERPT_WORDS) return words.join(' ');
  return `${words.slice(0, EXCERPT_WORDS).join(' ')}...`;
}

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
   * A single message as the board shows it, for a link that points at one entry.
   *
   * 20260902 ++ RG #deep_link_lookup
   * The board is paginated, so a shared message cannot be found by searching the
   * page the visitor happens to land on. Anything not published is a 404 here: the
   * board renders approved messages and nothing else, and a rejected one must not
   * become readable again through its id.
   *
   * @param {string} id
   */
  async publicMessage(id) {
    const message = await this.messages.findById(id);
    if (!message || !message.isPublished) throw new NotFoundError('Message', id);
    return message.toPublicJSON();
  }

  /**
   * Status lookup for the author returning with ids kept in localStorage.
   *
   * 20260902 ** RG #status_needs_an_excerpt
   * The status alone made a list of ten submissions unreadable: every row said
   * "in attesa di moderazione" and nothing else. The excerpt is the author's own
   * text coming back to a browser that already holds the id, so it publishes
   * nothing the caller did not write.
   *
   * @param {string[]} ids
   */
  async statusOf(ids) {
    const found = await Promise.all(ids.map((id) => this.messages.findById(id)));
    return found
      .filter((message) => message !== null)
      .map((message) => ({
        id: message.id,
        status: message.status,
        excerpt: excerptOf(message.text)
      }));
  }
}
