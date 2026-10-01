#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig } from './config.js';
import { log } from './log.js';
import { createServer, SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`aiworkpay-mcp-server: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const server = createServer({ config });
  await server.connect(new StdioServerTransport());
  log('info', 'server.started', {
    version: SERVER_VERSION,
    base_url: config.baseUrl,
    require_confirmation: config.requireConfirmation,
    max_mission_budget: config.maxMissionBudget,
    allowed_currencies: config.allowedCurrencies,
  });
}

main().catch((error: unknown) => {
  log('error', 'server.crashed', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
