import { createHash } from 'node:crypto';
import http from 'node:http';
import { isIP } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AiworkpayClient } from './api/client.js';
import type { HttpConfig } from './config.js';
import { log } from './log.js';
import { CreationLimiter } from './safety/creationLimiter.js';
import { createServer } from './server.js';

/**
 * Streamable HTTP transport, for agents that do not run next to this server.
 *
 * Stateless: every POST /mcp carries the agent's own AIWorkPay key
 * (`Authorization: Bearer awp_...`) and gets a fresh MCP server bound to that
 * key. This server stores no key and validates none itself: AIWorkPay does, on
 * every call, with the key's scopes and caps.
 *
 * Deploy it behind a TLS-terminating reverse proxy: keys must never travel in
 * clear text.
 */

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TRACKED_AGENTS = 10_000;
/** Failed authentications tolerated per client address and window, before AIWorkPay is no longer asked. */
const AUTH_FAILURES = { max: 10, windowMs: 10 * 60_000 };
/** How long a key AIWorkPay rejected is refused locally. */
const INVALID_KEY_TTL_MS = 60_000;
const MAX_TRACKED_ADDRESSES = 50_000;
const MAX_REMEMBERED_KEYS = 10_000;

/**
 * Failed authentications per client address. AIWorkPay counts them per address too, but sees only this server's:
 * without this, one attacker's guesses would use up the allowance shared by every agent behind the server.
 */
class FailureLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();
  blockedFor(ip: string, now = Date.now()): number {
    const entry = this.entries.get(ip);
    return entry && entry.resetAt > now && entry.count >= AUTH_FAILURES.max ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }
  record(ip: string, now = Date.now()): void {
    const entry = this.entries.get(ip);
    if (entry && entry.resetAt > now) entry.count += 1;
    else {
      if (this.entries.size >= MAX_TRACKED_ADDRESSES) this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(ip, { count: 1, resetAt: now + AUTH_FAILURES.windowMs });
    }
  }
}

/** The caller's address: what our own proxies appended to X-Forwarded-For (never what the client wrote), else the socket's. */
export function clientAddress(req: http.IncomingMessage, hops: number): string {
  const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (hops >= 1 && chain.length > 0) return chain[Math.max(0, chain.length - hops)]!;
  return req.socket.remoteAddress ?? 'unknown';
}

export interface HttpServerDeps {
  /** Injected in tests. */
  fetch?: typeof fetch;
}

export function createHttpServer(config: HttpConfig, deps: HttpServerDeps = {}): http.Server {
  // One creation limiter per agent key, so that one agent's loop cannot
  // exhaust another agent's allowance.
  const limiters = new Map<string, CreationLimiter>();
  const limiterFor = (agent: string) => {
    let limiter = limiters.get(agent);
    if (!limiter) {
      if (limiters.size >= MAX_TRACKED_AGENTS) limiters.delete(limiters.keys().next().value!);
      limiter = new CreationLimiter(config.maxCreationsPerHour);
      limiters.set(agent, limiter);
    }
    return limiter;
  };

  const failures = new FailureLimiter();
  const invalidKeys = new Map<string, number>(); // key fingerprint → refused until

  return http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log('error', 'http.crashed', { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];

    if (!hostAllowed(req.headers.host, config.allowedHosts)) {
      return jsonRpcError(res, 403, -32000, 'Host not allowed');
    }
    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) {
      return jsonRpcError(res, 403, -32000, 'Origin not allowed');
    }

    if (path === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    if (path !== '/mcp') return jsonRpcError(res, 404, -32000, 'Not found');
    if (req.method !== 'POST') {
      // Stateless server: no SSE stream to open (GET) and no session to end (DELETE).
      res.setHeader('Allow', 'POST');
      return jsonRpcError(res, 405, -32000, 'Method not allowed: this server is stateless, use POST');
    }

    const apiKey = bearerKey(req.headers.authorization);
    if (!apiKey) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="aiworkpay", error="invalid_token"');
      return jsonRpcError(res, 401, -32001, 'Missing AIWorkPay agent key: send Authorization: Bearer awp_...');
    }

    const agent = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
    const ip = clientAddress(req, config.trustedProxyHops ?? 1);

    const wait = failures.blockedFor(ip);
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      return jsonRpcError(res, 429, -32002, 'Too many failed authentications from this address: try again later');
    }
    const refusedUntil = invalidKeys.get(agent);
    if (refusedUntil && refusedUntil > Date.now()) {
      failures.record(ip);
      res.setHeader('WWW-Authenticate', 'Bearer realm="aiworkpay", error="invalid_token"');
      return jsonRpcError(res, 401, -32001, 'Invalid, expired or revoked AIWorkPay agent key');
    }

    const body = await readJson(req);
    if (body === TOO_LARGE) return jsonRpcError(res, 413, -32600, 'Request body too large');
    if (body === INVALID) return jsonRpcError(res, 400, -32700, 'Parse error');

    // Identify the agent in logs and limits without ever keeping its key. A key AIWorkPay rejects is remembered for a
    // minute and counted against the caller's address.
    const upstream = deps.fetch ?? fetch;
    const watched: typeof fetch = async (input, init) => {
      const response = await upstream(input, init);
      if (response.status === 403) {
        const rejected = (await response.clone().json().catch(() => null)) as { code?: string } | null;
        if (rejected?.code === 'INVALID_API_KEY') {
          const now = Date.now();
          if (invalidKeys.size >= MAX_REMEMBERED_KEYS) {
            for (const [fingerprint, until] of invalidKeys) if (until <= now) invalidKeys.delete(fingerprint);
            // Still full of live entries (many addresses guessing at once): drop the oldest rather than grow without bound
            if (invalidKeys.size >= MAX_REMEMBERED_KEYS) invalidKeys.delete(invalidKeys.keys().next().value!);
          }
          invalidKeys.set(agent, now + INVALID_KEY_TTL_MS);
          failures.record(ip);
        }
      }
      return response;
    };
    const client = new AiworkpayClient({
      baseUrl: config.baseUrl,
      apiKey,
      timeoutMs: config.timeoutMs,
      fetch: watched,
      // With the shared token AIWorkPay attributes limits to the real client instead of to this server
      extraHeaders: config.forwardToken && isIP(ip) ? { 'X-AIWorkPay-Client-IP': ip, 'X-AIWorkPay-Forward-Token': config.forwardToken } : undefined,
    });
    const server = createServer({ config, client, limiter: limiterFor(agent) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    log('info', 'http.request', { agent, method: rpcMethod(body), status: res.statusCode });
  }
}

function bearerKey(header: string | undefined): string | null {
  const match = header?.match(/^[Bb]earer\s+(awp_[A-Za-z0-9]{1,200})$/);
  return match?.[1] ?? null;
}

/** Host header without its port, compared case-insensitively. */
export function hostAllowed(host: string | undefined, allowed: string[]): boolean {
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
  return allowed.includes(name.toLowerCase());
}

const TOO_LARGE = Symbol('too large');
const INVALID = Symbol('invalid');

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return TOO_LARGE;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return INVALID;
  }
}

function rpcMethod(body: unknown): string | undefined {
  if (Array.isArray(body)) return 'batch';
  const method = (body as { method?: unknown } | null)?.method;
  return typeof method === 'string' ? method : undefined;
}

function jsonRpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
  res
    .writeHead(status, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}
