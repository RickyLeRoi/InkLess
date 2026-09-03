// backend/src/adapters/moderation/OpenAiModerationAdapter.js

import {
  REQUEST_TIMEOUT_MS,
  SYSTEM_PROMPT,
  describeFailure,
  parseVerdict,
  undecided
} from './llmProtocol.js';

/**
 * Speaks the OpenAI chat-completions protocol, which is the lingua franca of local
 * runtimes: LM Studio, vLLM, llama.cpp's server, OpenRouter and Ollama's own /v1
 * shim all answer it. Pointing MODERATION_LLM_BASE_URL at any of them is the whole
 * configuration difference.
 *
 * Satisfies the LlmModerationPort contract.
 */
export class OpenAiModerationAdapter {
  /**
   * @param {{ baseUrl: string, apiKey: string, model: string }} options
   */
  constructor({ baseUrl, apiKey, model }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.model = model;
  }

  /** @returns {Record<string, string>} */
  #headers() {
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/json' };
    // Local runtimes usually accept any key, or none at all.
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  /** @returns {Promise<boolean>} */
  async isAvailable() {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.#headers(),
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
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.#headers(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          // 20260903 ** RG #json_object_is_the_common_denominator
          // Deliberately not json_schema: this base URL is a gateway that rotates between
          // cloud providers and a local Ollama, so the strictest thing every one of them
          // accepts is a plain JSON object. The key order is held by the few-shot examples
          // in the prompt instead of by a grammar.
          response_format: { type: 'json_object' },
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

    return parseVerdict(payload?.choices?.[0]?.message?.content);
  }
}
