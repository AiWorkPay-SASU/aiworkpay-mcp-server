#!/usr/bin/env node
import { ConfigError, loadHttpConfig } from './config.js';
import { createHttpServer } from './http.js';
import { log } from './log.js';
import { SERVER_VERSION } from './server.js';

let config;
try {
  config = loadHttpConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`aiworkpay-mcp-http: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

const server = createHttpServer(config);
server.listen(config.port, config.host, () => {
  log('info', 'http.started', {
    version: SERVER_VERSION,
    url: `http://${config.host}:${config.port}/mcp`,
    base_url: config.baseUrl,
    allowed_hosts: config.allowedHosts,
    require_confirmation: config.requireConfirmation,
    max_mission_budget: config.maxMissionBudget,
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
