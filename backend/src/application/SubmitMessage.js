// backend/src/application/SubmitMessage.js

import { Message } from '../domain/Message.js';
import { normalizeInstagramHandle, normalizeMessageText } from '../domain/text.js';
import { ModerationVerdict, strictestOf } from '../ports/ModerationPort.js';

/**
 * Accepts a public submission and lets the moderation pipeline decide where it lands.
 */
export class SubmitMessage {
  /**
   * @param {object} deps
   * @param {import('../ports/MessageRepository.js').MessageRepository} deps.messages
   * @param {import('../ports/ModerationPort.js').ModerationPort} deps.moderation
   * @param {{ runIfNeeded: () => Promise<any> }} [deps.escalation]
   * @param {(error: unknown) => void} [deps.onEscalationError]
   */
  constructor({ messages, moderation, escalation, onEscalationError }) {
    this.messages = messages;
    this.moderation = moderation;
    this.escalation = escalation;
    this.onEscalationError = onEscalationError ?? (() => {});
  }

  /**
   * @param {object} input
   * @param {unknown} input.text
   * @param {unknown} [input.authorInstagram]
   * @returns {Promise<{ message: Message, verdict: string, reasons: string[], matches: string[] }>}
   */
  async execute(input) {
    const text = normalizeMessageText(input.text);
    const authorInstagram = normalizeInstagramHandle(input.authorInstagram);

    // 20260831 ++ RG #handle_is_content_too
    // The handle is displayed on the board and printed on the receipt, so it is
    // published content and gets judged like the body. Skipping it left an obvious
    // hole: an innocuous message signed with an offensive name sailed through.
    const judgements = [await this.moderation.evaluate(text)];
    if (authorInstagram) {
      judgements.push(await this.moderation.evaluateHandle(authorInstagram));
    }
    const { verdict, reasons, matches } = strictestOf(...judgements);

    // The Doe#NNN counter is only burned for submissions that will actually exist,
    // so a rejected spam run does not eat identities.
    const anonymousSequence = authorInstagram ? null : await this.messages.nextAnonymousSequence();

    const message = Message.submit({ text, authorInstagram, anonymousSequence });
    message.recordModeration(reasons);

    if (verdict === ModerationVerdict.AUTO_APPROVE) {
      message.approve();
    } else if (verdict === ModerationVerdict.REJECT) {
      message.reject();
    }

    await this.messages.save(message);

    if (message.status === 'pending') this.#considerEscalation();

    return { message, verdict, reasons, matches: matches ?? [] };
  }

  /**
   * Fires the batch check without making the submitter wait for a model that may
   * take a minute to answer.
   */
  #considerEscalation() {
    const escalation = this.escalation;
    if (!escalation) return;
    Promise.resolve()
      .then(() => escalation.runIfNeeded())
      .catch(this.onEscalationError);
  }
}
