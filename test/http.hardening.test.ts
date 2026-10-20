import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpConfig } from '../src/config.js';
import { clientAddress, createHttpServer } from '../src/http.js';
import { FakeAiworkpayApi } from './fakeApi.js';

const GOOD = 'awp_aaaaaaaaaaaaaaaaaaaaaaaa';
const listTools = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
const callAccount = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_account","arguments":{}}}';

describe('HTTP transport: protection of the authentication allowance', () => {
  let api: FakeAiworkpayApi;
  let server: http.Server;
  let base: string;

  async function start(overrides: Partial<HttpConfig> = {}) {
    api = new FakeAiworkpayApi([GOOD]);
    server = createHttpServer(
      {
        baseUrl: 'https://aiworkpay.test', maxMissionBudget: 50, allowedCurrencies: ['EUR'], requireConfirmation: true, maxCreationsPerHour: 10,
        timeoutMs: 1000, host: '127.0.0.1', port: 0, allowedHosts: ['127.0.0.1'], allowedOrigins: [], ...overrides,
      },
      { fetch: api.fetch }
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  afterEach(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
  });

  const post = (key: string, headers: Record<string, string> = {}, body = callAccount) =>
    fetch(`${base}/mcp`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}`, ...headers },
    });
  const badKey = (i: number) => `awp_bad${String(i).padStart(3, '0')}${'0'.repeat(20)}`;

  it('reads the caller\'s address from what the proxies appended, never from what the client wrote', () => {
    const request = (xff: string | undefined) => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '10.0.0.9' } }) as never;
    expect(clientAddress(request('forged, 198.51.100.7'), 1)).toBe('198.51.100.7');
    expect(clientAddress(request('forged, 198.51.100.7, 172.70.0.1'), 2)).toBe('198.51.100.7');
    expect(clientAddress(request(undefined), 1)).toBe('10.0.0.9');
    expect(clientAddress(request('198.51.100.7'), 0)).toBe('10.0.0.9');
  });

  it('stops asking AIWorkPay after 10 failed authentications from an address, and answers 429 with a delay', async () => {
    await start();
    const attacker = { 'x-forwarded-for': '198.51.100.7' };
    for (let i = 0; i < 10; i++) expect((await post(badKey(i), attacker)).status).toBe(200); // the MCP layer answers; AIWorkPay refuses the call
    const calls = api.requests.length;
    expect(calls).toBeGreaterThanOrEqual(10);
    const blocked = await post(badKey(99), attacker);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(((await blocked.json()) as any).error.code).toBe(-32002);
    expect((await post(GOOD, attacker)).status).toBe(429); // even a valid key, from that address
    expect(api.requests.length).toBe(calls); // AIWorkPay was not asked any more
  });

  it('does not let one address use up the others\' allowance, whatever it writes in X-Forwarded-For', async () => {
    await start();
    for (let i = 0; i < 12; i++) await post(badKey(i), { 'x-forwarded-for': `forged-${i}, 198.51.100.7` }); // forged entries on the left change nothing
    expect((await post(badKey(50), { 'x-forwarded-for': 'forged-again, 198.51.100.7' })).status).toBe(429);
    const other = await post(GOOD, { 'x-forwarded-for': '203.0.113.20' });
    expect(other.status).toBe(200);
    expect(((await other.json()) as any).result).toBeDefined();
  });

  it('remembers a rejected key for a minute: a loop with the same bad key costs AIWorkPay one call', async () => {
    await start();
    const first = await post(badKey(1), { 'x-forwarded-for': '203.0.113.30' });
    expect(first.status).toBe(200);
    const upstream = api.requests.length;
    const again = await post(badKey(1), { 'x-forwarded-for': '203.0.113.30' });
    expect(again.status).toBe(401);
    expect(again.headers.get('www-authenticate')).toMatch(/invalid_token/);
    expect(api.requests.length).toBe(upstream);
  });

  it('vouches for the real client address to AIWorkPay only when the shared token is configured', async () => {
    await start({ forwardToken: 'shared-token-0123456789' });
    await post(GOOD, { 'x-forwarded-for': '203.0.113.44' });
    const call = api.requests.find((r) => r.url.startsWith('/api/account'))!;
    expect(call.headers['x-aiworkpay-client-ip']).toBe('203.0.113.44');
    expect(call.headers['x-aiworkpay-forward-token']).toBe('shared-token-0123456789');
    expect(call.headers.authorization).toBe(`Bearer ${GOOD}`);
    await new Promise((resolve) => server.close(resolve));

    await start();
    await post(GOOD, { 'x-forwarded-for': '203.0.113.44' });
    const plain = api.requests.find((r) => r.url.startsWith('/api/account'))!;
    expect(plain.headers['x-aiworkpay-client-ip']).toBeUndefined();
    expect(plain.headers['x-aiworkpay-forward-token']).toBeUndefined();
  });

  it('accepts a lowercase bearer scheme (RFC 9110) but not a lowercase key prefix, nor another scheme', async () => {
    await start();
    expect((await post(GOOD, { authorization: `bearer ${GOOD}` }, listTools)).status).toBe(200);
    expect((await post(GOOD, { authorization: `Bearer AWP_${'a'.repeat(24)}` }, listTools)).status).toBe(401);
    expect((await post(GOOD, { authorization: `Basic ${Buffer.from('awp:x').toString('base64')}` }, listTools)).status).toBe(401);
    expect((await post(GOOD, { authorization: 'Bearer ' }, listTools)).status).toBe(401);
  });
});
