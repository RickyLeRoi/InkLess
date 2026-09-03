// backend/src/composition.js

import { JobEventBus } from './adapters/events/JobEventBus.js';
import { DisabledLlmAdapter } from './adapters/moderation/DisabledLlmAdapter.js';
import { OllamaModerationAdapter } from './adapters/moderation/OllamaModerationAdapter.js';
import { OpenAiModerationAdapter } from './adapters/moderation/OpenAiModerationAdapter.js';
import { RegexModerationAdapter } from './adapters/moderation/RegexModerationAdapter.js';
import { FakePaymentAdapter } from './adapters/payment/FakePaymentAdapter.js';
import { KofiPaymentAdapter } from './adapters/payment/KofiPaymentAdapter.js';
import { PayPalPaymentAdapter } from './adapters/payment/PayPalPaymentAdapter.js';
import { StripePaymentAdapter } from './adapters/payment/StripePaymentAdapter.js';
import { createDatabase } from './adapters/persistence/database.js';
import { SqliteMessageRepository } from './adapters/persistence/SqliteMessageRepository.js';
import { SqlitePrintJobRepository } from './adapters/persistence/SqlitePrintJobRepository.js';
import { SqliteUnmatchedDonationRepository } from './adapters/persistence/SqliteUnmatchedDonationRepository.js';
import { InProcessPrintQueue } from './adapters/queue/InProcessPrintQueue.js';
import { ConfirmPayment } from './application/ConfirmPayment.js';
import { EscalateModeration } from './application/EscalateModeration.js';
import { ListBoard } from './application/ListBoard.js';
import { MatchKofiDonation } from './application/MatchKofiDonation.js';
import { ModerateMessage } from './application/ModerateMessage.js';
import { RequestPrint } from './application/RequestPrint.js';
import { SubmitMessage } from './application/SubmitMessage.js';
import { TrackPrintJob } from './application/TrackPrintJob.js';

// 20260903 ++ RG #kofi_shares_the_fake_callback_path
// The fake adapter's route stays '/callback', unchanged from before this file grew
// per-provider routes: it is what the e2e stack and backend tests already call, and it
// never corresponds to anything registered in a real provider's dashboard.
/** @type {Readonly<Record<string, string>>} */
const WEBHOOK_ROUTE_PATH = Object.freeze({ fake: 'callback', stripe: 'stripe', paypal: 'paypal', kofi: 'kofi' });

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
  const unmatchedDonations =
    overrides.unmatchedDonations ?? new SqliteUnmatchedDonationRepository(db);
  const moderation = overrides.moderation ?? new RegexModerationAdapter();
  const printQueue = overrides.printQueue ?? new InProcessPrintQueue();
  const jobEvents = overrides.jobEvents ?? new JobEventBus();
  const llm = overrides.llm ?? createLlmAdapter(config);

  // overrides.payments is the older, single-adapter override some tests still use —
  // routed through the same 'callback' path the fake adapter always used, so it keeps
  // working exactly as before this file grew per-provider routes.
  const paymentAdapters =
    overrides.paymentAdapters ??
    (overrides.payments
      ? { fake: overrides.payments }
      : createPaymentAdapters(config, { jobs, unmatchedDonations }));

  const payments = overrides.payments ?? paymentAdapters[config.payments.provider];
  if (!payments) {
    throw new Error(
      `PAYMENT_PROVIDER "${config.payments.provider}" has no adapter configured — check its credentials`
    );
  }

  // 20260903 ++ RG #webhooks_outlive_a_provider_switch
  // One ConfirmPayment per configured adapter, not just the active one: a job created
  // under a provider that PAYMENT_PROVIDER no longer names can still have its webhook
  // arrive late, and it must still resolve rather than 404.
  const confirmPaymentByProvider = Object.fromEntries(
    Object.entries(paymentAdapters).map(([provider, adapter]) => [
      WEBHOOK_ROUTE_PATH[provider] ?? provider,
      new ConfirmPayment({ messages, jobs, payments: adapter, printQueue })
    ])
  );

  const escalation = new EscalateModeration({
    messages,
    moderation,
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
    unmatchedDonations,
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
    confirmPaymentByProvider,
    matchKofiDonation: new MatchKofiDonation({ messages, jobs, unmatchedDonations, printQueue }),
    trackPrintJob: new TrackPrintJob({ messages, jobs })
  };
}

/**
 * Builds an adapter for every provider that has credentials configured, keyed by
 * provider name — not just the one PAYMENT_PROVIDER names. See
 * #webhooks_outlive_a_provider_switch above for why the inactive ones still matter.
 *
 * @param {any} config
 * @param {{
 *   jobs: import('./ports/PrintJobRepository.js').PrintJobRepository,
 *   unmatchedDonations: import('./ports/UnmatchedDonationRepository.js').UnmatchedDonationRepository
 * }} deps
 * @returns {Record<string, import('./ports/PaymentPort.js').PaymentPort>}
 */
function createPaymentAdapters(config, { jobs, unmatchedDonations }) {
  /** @type {Record<string, import('./ports/PaymentPort.js').PaymentPort>} */
  const adapters = {};

  if (config.payments.stripeSecretKey && config.payments.stripeWebhookSecret) {
    adapters.stripe = new StripePaymentAdapter({
      secretKey: config.payments.stripeSecretKey,
      webhookSecret: config.payments.stripeWebhookSecret
    });
  }

  if (
    config.payments.paypalClientId &&
    config.payments.paypalClientSecret &&
    config.payments.paypalWebhookId
  ) {
    adapters.paypal = new PayPalPaymentAdapter({
      clientId: config.payments.paypalClientId,
      clientSecret: config.payments.paypalClientSecret,
      webhookId: config.payments.paypalWebhookId,
      environment: config.payments.paypalEnvironment
    });
  }

  if (config.payments.kofiWebhookSecret) {
    adapters.kofi = new KofiPaymentAdapter({
      webhookSecret: config.payments.kofiWebhookSecret,
      pageUrl: config.payments.kofiPageUrl,
      jobs,
      unmatchedDonations
    });
  }

  // Never in production: a real deployment must name a real provider, not fall back
  // to one that always reports success.
  if (!config.isProduction) {
    adapters.fake = new FakePaymentAdapter();
  }

  return adapters;
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
