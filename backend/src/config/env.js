// backend/src/config/env.js

/**
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function integer(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer`);
  }
  return parsed;
}

/**
 * @returns {any}
 */
export function loadConfig() {
  const isProduction = process.env.NODE_ENV === 'production';

  return {
    isProduction,
    host: process.env.HOST ?? '0.0.0.0',
    port: integer('PORT', 3000),
    databasePath: process.env.DATABASE_PATH ?? './data/inkless.db',
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173',
    // 20260831 ** RG #cors_required_in_production
    // admin.user/admin.password/hardwareToken already fail loud when missing in production;
    // this fell back to '*' silently instead, which defeats the point of having it at all.
    corsOrigin: isProduction ? required('CORS_ORIGIN') : (process.env.CORS_ORIGIN ?? '*'),

    admin: {
      user: isProduction ? required('ADMIN_USER') : (process.env.ADMIN_USER ?? 'admin'),
      password: isProduction
        ? required('ADMIN_PASSWORD')
        : (process.env.ADMIN_PASSWORD ?? 'inkless-dev')
    },

    // Shared secret for the RPi node. It never crosses the tunnel, only the LAN.
    hardwareToken: isProduction
      ? required('HARDWARE_TOKEN')
      : (process.env.HARDWARE_TOKEN ?? 'inkless-dev-hardware'),

    moderation: {
      // Queue depth at which the pending backlog is handed to the model.
      llmThreshold: integer('MODERATION_LLM_THRESHOLD', 50),
      llmBatchSize: integer('MODERATION_LLM_BATCH_SIZE', 100),
      // ollama | openai | none
      llmProvider: process.env.MODERATION_LLM_PROVIDER ?? 'none',
      llmModel: process.env.MODERATION_LLM_MODEL ?? 'llama3.2:3b',
      // Ollama's native API lives at the host root; anything OpenAI-compatible wants
      // the /v1 prefix included here.
      llmBaseUrl: process.env.MODERATION_LLM_BASE_URL ?? 'http://127.0.0.1:11434',
      llmApiKey: process.env.MODERATION_LLM_API_KEY ?? ''
    },

    rateLimit: {
      submissionsPerHour: integer('RATE_LIMIT_SUBMISSIONS_PER_HOUR', 3),
      printsPerHour: integer('RATE_LIMIT_PRINTS_PER_HOUR', 10)
    },

    payments: {
      // stripe | paypal | fake
      provider: process.env.PAYMENT_PROVIDER ?? 'fake',
      stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
      paypalClientId: process.env.PAYPAL_CLIENT_ID ?? '',
      paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET ?? '',
      paypalWebhookId: process.env.PAYPAL_WEBHOOK_ID ?? '',
      paypalEnvironment: process.env.PAYPAL_ENVIRONMENT ?? 'live'
    }
  };
}
