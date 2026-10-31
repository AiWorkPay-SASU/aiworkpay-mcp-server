import { describe, expect, it } from 'vitest';
import { AiworkpayApiError, AiworkpayClient } from '../src/api/client.js';
import { ConfigError, loadConfig, loadHttpConfig } from '../src/config.js';
import { hostAllowed } from '../src/http.js';
import { idempotencyKeyFor, renderDescription, toCreateRequest, type MissionInput } from '../src/domain/missionInput.js';
import { missionView, toAgentStatus } from '../src/domain/missionStatus.js';
import { payworkerAmount } from '../src/tools/reviewMissions.js';
import { CreationLimiter } from '../src/safety/creationLimiter.js';
import { assertSpendAllowed, GuardError } from '../src/safety/spendGuard.js';
import type { Mission } from '../src/api/types.js';

const future = new Date(Date.now() + 7 * 864e5).toISOString();

const input: MissionInput = {
  type: 'physical_verification',
  title: 'Vérifier un commerce',
  instructions: 'Vérifier que le commerce existe et est ouvert.',
  location: { city: 'Casablanca', address: '12 rue Example' },
  deliverables: ['Photo de la façade', 'Horaires'],
  budget: 15,
  currency: 'eur',
  deadline: future,
  priority: 'high',
};

describe('config', () => {
  const base = { AIWORKPAY_BASE_URL: 'https://aiworkpay.fr/', AIWORKPAY_API_KEY: 'awp_x' };

  it('applies safe defaults', () => {
    expect(loadConfig(base)).toEqual({
      baseUrl: 'https://aiworkpay.fr',
      apiKey: 'awp_x',
      maxMissionBudget: 50,
      allowedCurrencies: ['EUR'],
      requireConfirmation: true,
      maxCreationsPerHour: 10,
      timeoutMs: 15000,
    });
  });

  it('parses overrides', () => {
    const c = loadConfig({ ...base, AIWORKPAY_ALLOWED_CURRENCIES: 'eur, mad', AIWORKPAY_REQUIRE_CONFIRMATION: 'false' });
    expect(c.allowedCurrencies).toEqual(['EUR', 'MAD']);
    expect(c.requireConfirmation).toBe(false);
  });

  it('refuses plain http except for localhost, and non-agent keys', () => {
    expect(() => loadConfig({ ...base, AIWORKPAY_BASE_URL: 'http://aiworkpay.fr' })).toThrow(ConfigError);
    expect(loadConfig({ ...base, AIWORKPAY_BASE_URL: 'http://localhost:3000' }).baseUrl).toBe('http://localhost:3000');
    expect(() => loadConfig({ ...base, AIWORKPAY_API_KEY: 'sk_live_x' })).toThrow(/awp_/);
    expect(() => loadConfig({})).toThrow(ConfigError);
  });
});

describe('http config', () => {
  it('needs no API key and defaults to localhost', () => {
    const c = loadHttpConfig({ AIWORKPAY_BASE_URL: 'https://aiworkpay.fr' });
    expect(c).toMatchObject({ host: '127.0.0.1', port: 3333, allowedHosts: ['localhost', '127.0.0.1'], allowedOrigins: [] });
    expect(c).not.toHaveProperty('apiKey');
    expect(loadHttpConfig({ AIWORKPAY_BASE_URL: 'https://x.fr', MCP_ALLOWED_HOSTS: 'MCP.AIWorkPay.fr, localhost' }).allowedHosts).toEqual([
      'mcp.aiworkpay.fr',
      'localhost',
    ]);
  });

  it('checks the Host header without its port', () => {
    expect(hostAllowed('localhost:3333', ['localhost'])).toBe(true);
    expect(hostAllowed('LOCALHOST', ['localhost'])).toBe(true);
    expect(hostAllowed('[::1]:3333', ['[::1]'])).toBe(true);
    expect(hostAllowed('evil.example:3333', ['localhost'])).toBe(false);
    expect(hostAllowed(undefined, ['localhost'])).toBe(false);
  });
});

describe('mission input', () => {
  it('renders type, location and deliverables into the description', () => {
    const description = renderDescription(input);
    expect(description).toContain('Type de mission : Vérification physique sur place');
    expect(description).toContain('- Adresse : 12 rue Example\n- Ville : Casablanca');
    expect(description).toContain('Livrables attendus :\n- Photo de la façade\n- Horaires');
    expect(description).not.toContain('Pays');
  });

  it('builds a checkout request', () => {
    expect(toCreateRequest(input)).toMatchObject({ currency: 'EUR', priority: 'HIGH', paymentMode: 'checkout', budget: 15 });
  });

  it('derives a stable, valid idempotency key', () => {
    const request = toCreateRequest(input);
    const key = idempotencyKeyFor(input, request);
    expect(key).toMatch(/^[A-Za-z0-9_.:-]{8,255}$/);
    expect(idempotencyKeyFor(input, request)).toBe(key);
    expect(idempotencyKeyFor({ ...input, budget: 16 }, toCreateRequest({ ...input, budget: 16 }))).not.toBe(key);
    const withRef = { ...input, client_reference: 'shop 42 / é' };
    expect(idempotencyKeyFor(withRef, request)).toMatch(/^mcp-[a-f0-9]{48}$/);
    expect(idempotencyKeyFor({ ...withRef, budget: 99 }, request)).toBe(idempotencyKeyFor(withRef, request));
  });
});

describe('spend guard', () => {
  const config = { maxMissionBudget: 20, allowedCurrencies: ['EUR'] };
  const code = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      return (error as GuardError).code;
    }
    return 'OK';
  };

  it('enforces currency, budget cap and deadline', () => {
    expect(code(() => assertSpendAllowed(input, config))).toBe('OK');
    expect(code(() => assertSpendAllowed({ ...input, currency: 'MAD' }, config))).toBe('CURRENCY_NOT_ALLOWED');
    expect(code(() => assertSpendAllowed({ ...input, budget: 20.01 }, config))).toBe('BUDGET_CAP_EXCEEDED');
    expect(code(() => assertSpendAllowed({ ...input, deadline: '2020-01-01T00:00:00Z' }, config))).toBe('DEADLINE_IN_THE_PAST');
  });
});

describe('creation limiter', () => {
  it('allows N per rolling hour', () => {
    let now = 0;
    const limiter = new CreationLimiter(2, () => now);
    limiter.record('k1');
    now = 10 * 60_000;
    limiter.record('k2');
    expect(limiter.retryAfterSeconds()).toBe(50 * 60);
    expect(limiter.retryAfterSeconds('k1')).toBe(0);
    now = 60 * 60_000 + 1;
    expect(limiter.retryAfterSeconds()).toBe(0);
  });

  it('0 disables creation', () => {
    expect(new CreationLimiter(0).retryAfterSeconds()).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('mission status', () => {
  const mission: Mission = {
    id: 'm1',
    title: 't',
    description: 'd',
    budget: '15.5',
    currency: 'EUR',
    deadline: '2026-01-01T00:00:00.000Z',
    priority: 'MEDIUM',
    status: 'PAYMENT_PENDING',
    checkoutUrl: 'https://checkout.stripe.com/x',
    createdAt: '2025-12-01T00:00:00.000Z',
    updatedAt: '2025-12-01T00:00:00.000Z',
  };

  it('maps statuses', () => {
    expect(toAgentStatus('PUBLISHED')).toBe('open');
    expect(toAgentStatus('DELIVERED')).toBe('delivered');
  });

  it('exposes the payment url only while awaiting payment', () => {
    const now = new Date('2025-12-15T00:00:00Z');
    expect(missionView(mission, now)).toMatchObject({ status: 'awaiting_payment', budget: 15.5, payment_url: 'https://checkout.stripe.com/x' });
    expect(missionView({ ...mission, status: 'PUBLISHED' }, now).payment_url).toBeNull();
  });

  it('flags a past deadline only for unfinished missions', () => {
    const later = new Date('2026-02-01T00:00:00Z');
    expect(missionView({ ...mission, status: 'PUBLISHED' }, later).is_past_deadline).toBe(true);
    expect(missionView({ ...mission, status: 'COMPLETED' }, later).is_past_deadline).toBe(false);
  });
});

describe('api client', () => {
  it('sends the key, a request id and the idempotency key', async () => {
    let seen: Headers | undefined;
    const client = new AiworkpayClient({
      baseUrl: 'https://api.test',
      apiKey: 'awp_secret',
      timeoutMs: 1000,
      fetch: async (_url, init) => {
        seen = new Headers(init?.headers);
        return new Response(JSON.stringify({ mission: { id: 'm1', title: 'test', description: 'test', budget: 10, currency: 'EUR', deadline: '2030-01-01', priority: 'MEDIUM', status: 'PAYMENT_PENDING', createdAt: '', updatedAt: '' }, payment: null }), { status: 201 });
      },
    });
    const result = await client.createMission(toCreateRequest(input), 'mcp-abcdefgh');
    expect(result.replayed).toBe(false);
    expect(seen?.get('authorization')).toBe('Bearer awp_secret');
    expect(seen?.get('idempotency-key')).toBe('mcp-abcdefgh');
    expect(seen?.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('turns API errors into typed errors', async () => {
    const client = new AiworkpayClient({
      baseUrl: 'https://api.test',
      apiKey: 'awp_x',
      timeoutMs: 1000,
      fetch: async () => new Response(JSON.stringify({ error: 'Mission introuvable', code: 'MISSION_NOT_FOUND' }), { status: 404 }),
    });
    await expect(client.getMission('x')).rejects.toMatchObject({ code: 'MISSION_NOT_FOUND', status: 404 });
  });

  it('falls back to a status-based code and handles timeouts', async () => {
    const plain = new AiworkpayClient({
      baseUrl: 'https://api.test',
      apiKey: 'awp_x',
      timeoutMs: 1000,
      fetch: async () => new Response('<html>', { status: 502 }),
    });
    await expect(plain.getMission('x')).rejects.toMatchObject({ code: 'API_ERROR', status: 502 });

    const slow = new AiworkpayClient({
      baseUrl: 'https://api.test',
      apiKey: 'awp_x',
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });
    const error = await slow.getMission('x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiworkpayApiError);
    expect(error).toMatchObject({ code: 'TIMEOUT', status: 0 });
  });
});



describe('reservation and response safety', () => {
  it('reserves synchronously and prunes expired references', () => {
    let now = 0;
    const limiter = new CreationLimiter(1, () => now);
    expect(limiter.reserve('one')).toBe(0);
    expect(limiter.reserve('two')).toBeGreaterThan(0);
    limiter.record('one');
    now = 3600001;
    expect(limiter.reserve('two')).toBe(0);
    expect(limiter.reserve('one')).toBeGreaterThan(0);
  });
  it('rejects valid JSON with an invalid mission shape', async () => {
    const client = new AiworkpayClient({baseUrl: 'https://api.test', apiKey: 'awp_test', timeoutMs: 1000, fetch: async () => new Response('{}')});
    await expect(client.getMission('m')).rejects.toMatchObject({code: 'INVALID_RESPONSE'});
  });
  it('stops oversized proof streams even without Content-Length', async () => {
    let canceled = false;
    const stream = new ReadableStream({start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel() { canceled = true; }});
    const client = new AiworkpayClient({baseUrl: 'https://api.test', apiKey: 'awp_test', timeoutMs: 1000, fetch: async () => new Response(stream)});
    await expect(client.downloadProof('m','p',10)).rejects.toMatchObject({code: 'PROOF_TOO_LARGE'});
    expect(canceled).toBe(true);
  });
});

describe('CreationLimiter.available', () => {
  it('counts what is left in the rolling hour', async () => {
    const { CreationLimiter } = await import('../src/safety/creationLimiter.js');
    let now = 0;
    const limiter = new CreationLimiter(3, () => now);
    expect(limiter.available()).toBe(3);
    limiter.reserve('a'); limiter.record('a');
    limiter.reserve('b'); limiter.record('b');
    expect(limiter.available()).toBe(1);
    now = 61 * 60 * 1000;
    expect(limiter.available()).toBe(3);
    expect(new CreationLimiter(0).available()).toBe(0);
  });
});

describe('approve_result preview amount', () => {
  it('uses the backend rounding: parseFloat((budget * 0.9).toFixed(2))', () => {
    // 0.95 * 0.9 = 0.855…: the backend pays 0.85, Math.round(x * 0.9 * 100) / 100 would announce 0.86.
    expect(payworkerAmount(0.95)).toBe(0.85);
    expect(payworkerAmount(1.45)).toBe(1.3);
    expect(payworkerAmount(15)).toBe(13.5);
  });
});
