import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AiworkpayClient } from '../src/api/client.js';
import { createServer, SERVER_VERSION } from '../src/server.js';
import { FakeAiworkpayApi } from './fakeApi.js';

/** What the server promises (README, server.json, package.json) must be what it does. */
describe('contract of the MCP server', () => {
  let client: Client;
  let tools: Awaited<ReturnType<Client['listTools']>>['tools'];

  beforeEach(async () => {
    const api = new FakeAiworkpayApi();
    const config = { baseUrl: 'https://aiworkpay.test', maxMissionBudget: 50, allowedCurrencies: ['EUR'], requireConfirmation: true, maxCreationsPerHour: 10, timeoutMs: 1000 };
    const server = createServer({ config, client: new AiworkpayClient({ baseUrl: config.baseUrl, apiKey: 'awp_test', timeoutMs: 1000, fetch: api.fetch }) });
    const [c, s] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'contract', version: '1' });
    await Promise.all([server.connect(s), client.connect(c)]);
    tools = (await client.listTools()).tools;
  });
  afterEach(async () => client.close());

  it('registers exactly the tools the README documents', () => {
    const readme = readFileSync('README.md', 'utf8');
    const table = readme.slice(readme.indexOf('## Tools'), readme.indexOf('Statuts exposés'));
    const documented = [...table.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]).sort();
    expect(tools.map((t) => t.name).sort()).toEqual(documented);
    expect(documented).toHaveLength(13);
  });

  it('describes every tool and declares what it can do to the world (annotations)', () => {
    for (const tool of tools) {
      expect(tool.description?.length, `${tool.name} description`).toBeGreaterThan(30);
      expect(tool.title ?? tool.annotations?.title, `${tool.name} title`).toBeTruthy();
      expect(typeof tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe('boolean');
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('flags every tool that moves money or cannot be undone, and only those', () => {
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort();
    expect(destructive).toEqual(['approve_result', 'cancel_mission']); // creating a mission only produces a payment link for a human
    expect(tools.find((t) => t.name === 'create_mission')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual(['get_account', 'get_mission', 'get_mission_result', 'get_mission_status', 'get_proof_file', 'get_workforce_handoff', 'list_missions', 'list_transactions', 'prepare_workforce_handoff'].sort());
    for (const name of ['create_mission', 'approve_result', 'cancel_mission']) {
      expect(Object.keys(tools.find((t) => t.name === name)!.inputSchema.properties ?? {}), name).toContain('confirm');
    }
  });

  it('never offers a way to pay with a payment method, or to choose the payment mode', () => {
    const create = tools.find((t) => t.name === 'create_mission')!;
    const properties = Object.keys(create.inputSchema.properties ?? {});
    for (const forbidden of ['payment_method', 'paymentMethodId', 'payment_method_id', 'payment_mode', 'paymentMode', 'card']) {
      expect(properties).not.toContain(forbidden);
    }
  });

  it('publishes self-contained input schemas (no $ref that agent frameworks cannot resolve)', () => {
    for (const tool of tools) expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain('$ref');
  });

  it('keeps version numbers consistent', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it('answers unknown methods and tools with errors, not crashes', async () => {
    const unknown = (await client.callTool({ name: 'does_not_exist', arguments: {} })) as { isError?: boolean };
    expect(unknown.isError).toBe(true);
    const bad = (await client.callTool({ name: 'get_mission', arguments: { mission_id: '' } })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
  });
});
