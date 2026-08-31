// backend/src/adapters/moderation/OllamaModerationAdapter.js

import {
  REQUEST_TIMEOUT_MS,
  SYSTEM_PROMPT,
  describeFailure,
  parseVerdict,
  undecided
} from './llmProtocol.js';

/**
 * Ollama's native API. Kept alongside the OpenAI-compatible adapter because /api/chat
 * exposes `format: 'json'`, which constrains decoding at the sampler rather than
 * merely asking the model nicely — noticeably more reliable on the small models that
 * fit on an RPi 4.
 *
 * Satisfies the LlmModerationPort contract.
 */
export class OllamaModerationAdapter {
  /**
   * @param {{ baseUrl: string, model: string }} options
   */
  constructor({ baseUrl, model }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  /** @returns {Promise<boolean>} */
  async isAvailable() {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * @param {string} text
   * @returns {Promise<import('../../ports/ModerationPort.js').ModerationResult>}
   */
  async evaluate(text) {
    let payload;
    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: 'json',
          options: { temperature: 0 },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text }
          ]
        })
      });

      if (!response.ok) return undecided(`http_${response.status}`);
      payload = await response.json();
    } catch (error) {
      return describeFailure(error);
    }

    return parseVerdict(payload?.message?.content);
  }
}
