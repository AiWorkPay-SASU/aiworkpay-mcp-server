import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { HttpConfig } from '../src/config.js';
import { createHttpServer } from '../src/http.js';
import { FakeAiworkpayApi } from './fakeApi.js';

const KEY_A = 'awp_aaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'awp_bbbbbbbbbbbbbbbbbbbbbbbb';

const order = {
  type: 'photo',
  title: 'Photo d’une vitrine',
  instructions: 'Prendre en photo la vitrine du magasin.',
  budget: 10,
  currency: 'EUR',
  deadline: new Date(Date.now() + 2 * 864e5).toISOString(),
  confirm: true,
};

type Result = { isError?: boolean; structuredContent?: Record<string, unknown> };

describe('Streamable HTTP transport', () => {
  let api: FakeAiworkpayApi;
  let server: http.Server;
  let base: string;
  const clients: Client[] = [];

  async function start(overrides: Partial<HttpConfig> = {}) {
    api = new FakeAiworkpayApi([KEY_A, KEY_B]);
    server = createHttpServer(
      {
        baseUrl: 'https://aiworkpay.test',
        maxMissionBudget: 50,
        allowedCurrencies: ['EUR'],
        requireConfirmation: true,
        maxCreationsPerHour: 10,
        timeoutMs: 1000,
        host: '127.0.0.1',
        port: 0,
        allowedHosts: ['127.0.0.1'],
        allowedOrigins: ['https://app.example'],
        ...overrides,
      },
      { fetch: api.fetch }
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function connect(key: string) {
    const client = new Client({ name: 'remote-agent', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } })
    );
    clients.push(client);
    return async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as Result;
  }

  beforeEach(async () => start());
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await new Promise((resolve) => server.close(resolve));
    vi.restoreAllMocks();
  });

  const post = (headers: Record<string, string>, body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}') =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body,
    });

  it('serves the full toolset to an authenticated agent', async () => {
    const call = await connect(KEY_A);
    const created = await call('create_mission', order);
    expect(created.structuredContent).toMatchObject({ created: true, status: 'awaiting_payment' });
    expect(api.requests.at(-1)?.headers.authorization).toBe(`Bearer ${KEY_A}`);

    const status = await call('get_mission_status', { mission_id: created.structuredContent?.mission_id });
    expect(status.structuredContent).toMatchObject({ status: 'awaiting_payment' });
  });

  it('keeps agents apart: each request uses its own key', async () => {
    const callA = await connect(KEY_A);
    const callB = await connect(KEY_B);
    const created = await callA('create_mission', order);
    const stolen = await callB('get_mission', { mission_id: created.structuredContent?.mission_id });
    expect(stolen.structuredContent?.error).toMatchObject({ code: 'MISSION_NOT_FOUND' });
    expect(api.requests.at(-1)?.headers.authorization).toBe(`Bearer ${KEY_B}`);
  });

  it('applies the creation limit per agent', async () => {
    await new Promise((resolve) => server.close(resolve));
    await start({ maxCreationsPerHour: 1 });
    const callA = await connect(KEY_A);
    const callB = await connect(KEY_B);
    expect((await callA('create_mission', order)).isError).toBeFalsy();
    const blocked = await callA('create_mission', { ...order, client_reference: 'second' });
    expect(blocked.structuredContent?.error).toMatchObject({ code: 'CREATION_LIMIT_REACHED' });
    expect((await callB('create_mission', order)).isError).toBeFalsy();
  });

  it('reports the API rate limit with its delay and a hint', async () => {
    const call = await connect(KEY_A);
    api.failNext = { status: 429, body: { error: 'trop', code: 'RATE_LIMITED' }, headers: { 'Retry-After': '42' } };
    const limited = await call('list_missions');
    expect(limited.structuredContent?.error).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retry_after_seconds: 42 });
    api.failNext = { status: 403, body: { error: 'scope', code: 'INSUFFICIENT_SCOPE' } };
    const scope = await call('list_missions');
    expect(String((scope.structuredContent?.error as { hint: string }).hint)).toContain('required scope');
  });

  it('rejects requests without a key, with a foreign host or origin', async () => {
    const noKey = await post({});
    expect(noKey.status).toBe(401);
    expect(noKey.headers.get('www-authenticate')).toContain('Bearer');

    expect((await post({ authorization: 'Bearer sk_live_nope' })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${KEY_A}`, origin: 'https://evil.example' })).status).toBe(403);

    const rebinding = await new Promise<number>((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const req = request(`${base}/mcp`, { method: 'POST', headers: { host: 'evil.example', authorization: `Bearer ${KEY_A}` } }, (res) =>
          resolve(res.statusCode ?? 0)
        );
        req.on('error', reject);
        req.end('{}');
      });
    });
    expect(rebinding).toBe(403);
    expect(api.requests).toHaveLength(0);
  });

  it('accepts an allowed browser origin', async () => {
    const res = await post({ authorization: `Bearer ${KEY_A}`, origin: 'https://app.example' });
    expect(res.status).toBe(200);
  });

  it('answers health checks and refuses other methods, paths and bodies', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/other`)).status).toBe(404);
    const get = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${KEY_A}` } });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await post({ authorization: `Bearer ${KEY_A}` }, '{oops')).status).toBe(400);
    expect((await post({ authorization: `Bearer ${KEY_A}` }, `"${'x'.repeat(1024 * 1024 + 10)}"`)).status).toBe(413);
  });

  it('never writes the key to the logs', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const call = await connect(KEY_A);
    await call('create_mission', order);
    await call('get_mission', { mission_id: 'unknown' });
    expect(lines.some((l) => l.includes('"event":"http.request"'))).toBe(true);
    expect(lines.join('')).not.toContain(KEY_A);
  });
});
