// backend/src/composition.js

import { JobEventBus } from './adapters/events/JobEventBus.js';
import { DisabledLlmAdapter } from './adapters/moderation/DisabledLlmAdapter.js';
import { OllamaModerationAdapter } from './adapters/moderation/OllamaModerationAdapter.js';
import { OpenAiModerationAdapter } from './adapters/moderation/OpenAiModerationAdapter.js';
import { RegexModerationAdapter } from './adapters/moderation/RegexModerationAdapter.js';
import { FakePaymentAdapter } from './adapters/payment/FakePaymentAdapter.js';
import { PayPalPaymentAdapter } from './adapters/payment/PayPalPaymentAdapter.js';
import { StripePaymentAdapter } from './adapters/payment/StripePaymentAdapter.js';
import { createDatabase } from './adapters/persistence/database.js';
import { SqliteMessageRepository } from './adapters/persistence/SqliteMessageRepository.js';
import { SqlitePrintJobRepository } from './adapters/persistence/SqlitePrintJobRepository.js';
import { InProcessPrintQueue } from './adapters/queue/InProcessPrintQueue.js';
import { ConfirmPayment } from './application/ConfirmPayment.js';
import { EscalateModeration } from './application/EscalateModeration.js';
import { ListBoard } from './application/ListBoard.js';
import { ModerateMessage } from './application/ModerateMessage.js';
import { RequestPrint } from './application/RequestPrint.js';
import { SubmitMessage } from './application/SubmitMessage.js';
import { TrackPrintJob } from './application/TrackPrintJob.js';

/**
 * The only place where concrete adapters are chosen. Everything downstream sees ports.
 *
 * @param {any} config
 * @param {any} [overrides] swap adapters in tests
 * @returns {any}
 */
export function composeApp(config, overrides = {}) {
  const db = overrides.db ?? createDatabase(config.databasePath);

  const messages = overrides.messages ?? new SqliteMessageRepository(db);
  const jobs = overrides.jobs ?? new SqlitePrintJobRepository(db);
  const moderation = overrides.moderation ?? new RegexModerationAdapter();
  const printQueue = overrides.printQueue ?? new InProcessPrintQueue();
  const jobEvents = overrides.jobEvents ?? new JobEventBus();
  const payments = overrides.payments ?? createPaymentAdapter(config);
  const llm = overrides.llm ?? createLlmAdapter(config);

  const escalation = new EscalateModeration({
    messages,
    llm,
    threshold: config.moderation.llmThreshold,
    batchSize: config.moderation.llmBatchSize
  });

  return {
    llm,
    escalation,
    config,
    db,
    messages,
    jobs,
    moderation,
    payments,
    printQueue,
    jobEvents,
    submitMessage: new SubmitMessage({ messages, moderation, escalation }),
    listBoard: new ListBoard({ messages }),
    moderateMessage: new ModerateMessage({ messages }),
    requestPrint: new RequestPrint({
      messages,
      jobs,
      payments,
      publicBaseUrl: config.publicBaseUrl
    }),
    confirmPayment: new ConfirmPayment({ messages, jobs, payments, printQueue }),
    trackPrintJob: new TrackPrintJob({ messages, jobs })
  };
}

/**
 * @param {any} config
 * @returns {import('./ports/PaymentPort.js').PaymentPort}
 */
function createPaymentAdapter(config) {
  if (config.payments.provider === 'stripe') {
    return new StripePaymentAdapter({
      secretKey: config.payments.stripeSecretKey,
      webhookSecret: config.payments.stripeWebhookSecret
    });
  }

  if (config.payments.provider === 'paypal') {
    return new PayPalPaymentAdapter({
      clientId: config.payments.paypalClientId,
      clientSecret: config.payments.paypalClientSecret,
      webhookId: config.payments.paypalWebhookId,
      environment: config.payments.paypalEnvironment
    });
  }

  if (config.isProduction) {
    throw new Error('PAYMENT_PROVIDER must name a real provider in production');
  }
  return new FakePaymentAdapter();
}

/**
 * @param {any} config
 * @returns {import('./ports/ModerationPort.js').LlmModerationPort}
 */
export function createLlmAdapter(config) {
  const { llmProvider, llmBaseUrl, llmApiKey, llmModel } = config.moderation;

  if (llmProvider === 'ollama') {
    return new OllamaModerationAdapter({ baseUrl: llmBaseUrl, model: llmModel });
  }
  if (llmProvider === 'openai') {
    return new OpenAiModerationAdapter({
      baseUrl: llmBaseUrl,
      apiKey: llmApiKey,
      model: llmModel
    });
  }
  return new DisabledLlmAdapter();
}
