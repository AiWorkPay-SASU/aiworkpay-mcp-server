#!/usr/bin/env node
import { ConfigError, loadHttpConfig } from './config.js';
import { createHttpServer } from './http.js';
import { log } from './log.js';
import { forwarderFingerprint, productionReport } from './productionGuards.js';
import { SERVER_VERSION } from './server.js';

// Production only: refuse an unsafe or incomplete configuration, naming settings but never printing a value
const report = productionReport();
if (report) {
  for (const warning of report.warnings) log('warn', 'config.warning', { message: warning });
  if (report.problems.length > 0) {
    for (const problem of report.problems) log('error', 'config.refused', { message: problem });
    process.stderr.write(`aiworkpay-mcp-http: refusing to start: ${report.problems.length} unsafe or incomplete production setting(s), listed above.\n`);
    process.exit(1);
  }
}

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

const fingerprint = forwarderFingerprint();
if (fingerprint) log('info', 'config.forwarder_fingerprint', { fingerprint, note: 'the backend logs the same value when it holds the same secret' });

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
