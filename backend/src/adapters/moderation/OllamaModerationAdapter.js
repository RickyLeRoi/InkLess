// backend/src/adapters/moderation/OllamaModerationAdapter.js

import {
  REQUEST_TIMEOUT_MS,
  RESPONSE_SCHEMA,
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
          // 20260903 ** RG #schema_over_bare_json
          // A schema rather than format:'json'. Ollama compiles it into a grammar, so the
          // reasoning key cannot be skipped or emitted after the verdict. Wants Ollama
          // 0.5.0 or newer; an older one answers 400 and the batch retries forever, which
          // the eval script reports as failed calls.
          format: RESPONSE_SCHEMA,
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
