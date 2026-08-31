// backend/src/index.js

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { composeApp } from './composition.js';
import { loadConfig } from './config/env.js';
import { buildServer } from './http/server.js';

const config = loadConfig();

if (config.databasePath !== ':memory:') {
  mkdirSync(dirname(config.databasePath), { recursive: true });
}

const app = composeApp(config);
const server = await buildServer(app);

try {
  await server.listen({ host: config.host, port: config.port });
} catch (error) {
  server.log.error(error);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await server.close();
    app.db.close();
    process.exit(0);
  });
}
