import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AiworkpayClient } from '../src/api/client.js';
import type { Config } from '../src/config.js';
import { CreationLimiter } from '../src/safety/creationLimiter.js';
import { createServer } from '../src/server.js';
import { FakeAiworkpayApi } from './fakeApi.js';

const deadline = new Date(Date.now() + 3 * 864e5).toISOString();
const order = (n: number, budget = 20) => ({
  type: 'physical_verification', title: `Vérifier un commerce ${n}`, instructions: 'Aller sur place et vérifier que le commerce existe.',
  budget, currency: 'EUR', deadline, client_reference: `ref-${n}`, confirm: true,
});

const config: Config = {
  baseUrl: 'https://aiworkpay.test', apiKey: 'awp_test', maxMissionBudget: 50, allowedCurrencies: ['EUR'],
  requireConfirmation: true, maxCreationsPerHour: 10, timeoutMs: 1000,
};
type Result = { isError?: boolean; structuredContent?: Record<string, any> };

describe('account and transactions tools', () => {
  let api: FakeAiworkpayApi;
  let client: Client;
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;

  beforeEach(async () => {
    api = new FakeAiworkpayApi();
    const server = createServer({
      config, limiter: new CreationLimiter(config.maxCreationsPerHour),
      client: new AiworkpayClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: 1000, fetch: api.fetch }),
    });
    const [c, s] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-agent', version: '1.0.0' });
    await Promise.all([server.connect(s), client.connect(c)]);
  });
  afterEach(async () => client.close());

  it('lists both tools as read-only', async () => {
    const tools = (await client.listTools()).tools;
    for (const name of ['get_account', 'list_transactions']) {
      expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('get_account shows budget left, creations left and the largest mission allowed now', async () => {
    const created = await call('create_mission', order(1, 40));
    api.pay(created.structuredContent!.mission_id);
    await call('create_mission', order(2, 25));

    const { structuredContent: a, isError } = await call('get_account');
    expect(isError).toBeFalsy();
    expect(a!.usage.committed_this_month).toBe(65);
    expect(a!.usage.remaining_this_month).toBe(235);
    expect(a!.usage.total_paid).toBe(40);
    expect(a!.missions.by_status).toEqual({ open: 1, awaiting_payment: 1 });
    expect(a!.operator_limits.creations_available_now).toBe(8);
    expect(a!.permissions.can_approve_and_review).toBe(true);
    expect(a!.effective_max_budget).toBe(50); // the operator cap (50) is the lowest ceiling
    expect(a!.can_create_now).toBe(true);
    expect(a!.agent.key_prefix).toBe('awp_test');
  });

  it('the largest mission shrinks to what the monthly budget still allows', async () => {
    api.limits = { maxMissionBudget: 100, monthlyBudget: 70 };
    await call('create_mission', order(1, 40));
    const { structuredContent: a } = await call('get_account');
    expect(a!.effective_max_budget).toBe(30);

    api.limits = { maxMissionBudget: 100, monthlyBudget: 40 };
    const full = (await call('get_account')).structuredContent!;
    expect(full.effective_max_budget).toBe(0);
    expect(full.can_create_now).toBe(false);
  });

  it('a read-only key cannot create, and the account says so', async () => {
    api.scopes = ['missions:read'];
    const { structuredContent: a } = await call('get_account');
    expect(a!.permissions).toMatchObject({ can_read: true, can_create_and_cancel: false, can_approve_and_review: false });
    expect(a!.can_create_now).toBe(false);
  });

  it('list_transactions shows payments newest first, marks refunds, filters and paginates', async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const m = await call('create_mission', order(n, 10 * n));
      ids.push(m.structuredContent!.mission_id);
      api.pay(ids[n - 1]!);
    }
    await call('cancel_mission', { mission_id: ids[1], confirm: true });

    const all = (await call('list_transactions')).structuredContent!;
    expect(all.total).toBe(3);
    expect(all.transactions.map((t: any) => t.amount)).toEqual([30, 20, 10]);
    expect(all.transactions.find((t: any) => t.mission_id === ids[1]).refunded).toBe(true);
    expect(all.transactions.find((t: any) => t.mission_id === ids[0]).refunded).toBe(false);
    expect(all.transactions.find((t: any) => t.mission_id === ids[1]).mission_status).toBe('canceled');

    const one = (await call('list_transactions', { mission_id: ids[0] })).structuredContent!;
    expect(one.count).toBe(1);

    const page = (await call('list_transactions', { limit: 2 })).structuredContent!;
    expect(page.count).toBe(2); expect(page.next_offset).toBe(2);
    const last = (await call('list_transactions', { limit: 2, offset: 2 })).structuredContent!;
    expect(last.count).toBe(1); expect(last.next_offset).toBeNull();
  });

  it('an instance without these routes answers with a hint instead of a crash', async () => {
    api.failNext = { status: 404, body: {} };
    const result = await call('get_account');
    expect(result.isError).toBe(true);
    expect(result.structuredContent!.error.code).toBe('NOT_FOUND');
    expect(result.structuredContent!.error.hint).toMatch(/update/i);
  });

  it('a Stripe outage on creation is reported as retryable with the same client_reference', async () => {
    api.failNext = { status: 502, body: { error: 'indisponible', code: 'PAYMENT_PROVIDER_UNAVAILABLE' } };
    const result = await call('create_mission', order(1));
    expect(result.isError).toBe(true);
    expect(result.structuredContent!.error).toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE', retryable: true });
    expect(result.structuredContent!.error.hint).toMatch(/same client_reference/);
    // the retry creates the mission once
    const retry = await call('create_mission', order(1));
    expect(retry.isError).toBeFalsy();
  });
});
