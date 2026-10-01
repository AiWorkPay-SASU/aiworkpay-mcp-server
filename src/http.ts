import { createHash } from 'node:crypto';
import http from 'node:http';
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

    const body = await readJson(req);
    if (body === TOO_LARGE) return jsonRpcError(res, 413, -32600, 'Request body too large');
    if (body === INVALID) return jsonRpcError(res, 400, -32700, 'Parse error');

    // Identify the agent in logs and limits without ever keeping its key.
    const agent = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
    const client = new AiworkpayClient({ baseUrl: config.baseUrl, apiKey, timeoutMs: config.timeoutMs, fetch: deps.fetch });
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
  const match = header?.match(/^Bearer\s+(awp_[A-Za-z0-9]{1,200})$/);
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
