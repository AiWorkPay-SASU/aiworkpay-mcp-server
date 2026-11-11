/**
 * The real HTTP entry point (dist/httpMain.js), started the way the container starts it (NODE_ENV=production): it must refuse an
 * unsafe or incomplete configuration with exit code 1 and a log that names settings but never prints a secret, start with a good one,
 * and stay untouched in development. Builds the project first.
 */
import { execFileSync, spawn } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';

const freePort = () => String(40_000 + Math.floor(Math.random() * 20_000));
const TOKEN = 'Tok3n-for-the-real-startup-test-must-stay-secret-0123';
const base = (): Record<string, string> => ({
  PATH: process.env.PATH ?? '',
  NODE_ENV: 'production',
  MCP_HTTP_HOST: '127.0.0.1', // loopback only for the test (the container uses 0.0.0.0): produces the one expected warning
  MCP_HTTP_PORT: freePort(),
  AIWORKPAY_BASE_URL: 'https://app.example.fr',
  MCP_ALLOWED_HOSTS: 'mcp.example.fr',
  MCP_TRUSTED_PROXY_HOPS: '1',
  AIWORKPAY_FORWARD_TOKEN: TOKEN,
  AIWORKPAY_MAX_MISSION_BUDGET: '50',
  AIWORKPAY_MAX_CREATIONS_PER_HOUR: '10',
  AIWORKPAY_ALLOWED_CURRENCIES: 'EUR',
});

interface Outcome { code: number | null; started: boolean; output: string }

function start(env: Record<string, string>): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn('node', ['dist/httpMain.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let started = false;
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (!started && output.includes('http.started')) { started = true; child.kill('SIGTERM'); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => resolve({ code, started, output }));
    setTimeout(() => child.kill('SIGKILL'), 20_000);
  });
}

describe('real startup of the HTTP server', () => {
  beforeAll(() => { execFileSync('npm', ['run', 'build'], { stdio: 'ignore' }); }, 120_000);

  it('starts with a complete production configuration', async () => {
    const result = await start(base());
    expect(result.started, result.output).toBe(true);
    expect(result.output).not.toContain('config.refused');
    // The startup log carries the fingerprint of the shared secret (to compare with the backend's), never the secret
    expect(result.output).toMatch(/"fingerprint":"[0-9a-f]{8}"/);
    expect(result.output).not.toContain(TOKEN);
  }, 30_000);

  for (const [name, patch, expected] of [
    ['MCP_TRUSTED_PROXY_HOPS not set', { MCP_TRUSTED_PROXY_HOPS: undefined }, /MCP_TRUSTED_PROXY_HOPS is not set/],
    ['MCP_TRUSTED_PROXY_HOPS=0', { MCP_TRUSTED_PROXY_HOPS: '0' }, /integer from 1 to 5/],
    ['AIWORKPAY_FORWARD_TOKEN not set', { AIWORKPAY_FORWARD_TOKEN: undefined }, /AIWORKPAY_FORWARD_TOKEN is not set/],
    ['AIWORKPAY_FORWARD_TOKEN too short', { AIWORKPAY_FORWARD_TOKEN: 'short-secret' }, /shorter than 16/],
    ['an unresolved Railway reference as the token', { AIWORKPAY_FORWARD_TOKEN: '${{backend.TRUSTED_FORWARDER_TOKEN}}' }, /unresolved reference/],
    ['a shared AIWORKPAY_API_KEY', { AIWORKPAY_API_KEY: 'awp_SHAREDKEYVALUE0123456789' }, /AIWORKPAY_API_KEY is set/],
    ['confirmation switched off', { AIWORKPAY_REQUIRE_CONFIRMATION: 'false' }, /CONFIRMATION is off/],
    ['localhost-only allowed hosts', { MCP_ALLOWED_HOSTS: 'localhost' }, /no public host/],
    ['a local backend address', { AIWORKPAY_BASE_URL: 'https://localhost:3000' }, /local address/],
  ] as Array<[string, Record<string, string | undefined>, RegExp]>) {
    it(`refuses to start with ${name}: exit code 1, setting named, no secret printed`, async () => {
      const env: Record<string, string | undefined> = { ...base(), ...patch };
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
      const result = await start(env as Record<string, string>);
      expect(result.started, result.output).toBe(false);
      expect(result.code).toBe(1);
      expect(result.output).toContain('config.refused');
      expect(result.output).toMatch(expected);
      for (const secret of [TOKEN, 'awp_SHAREDKEYVALUE0123456789']) expect(result.output).not.toContain(secret);
    }, 30_000);
  }

  it('outside production nothing is enforced: a development start without the production settings works', async () => {
    const env = { PATH: process.env.PATH ?? '', NODE_ENV: 'development', MCP_HTTP_PORT: freePort(), AIWORKPAY_BASE_URL: 'http://localhost:3000' };
    const result = await start(env);
    expect(result.started, result.output).toBe(true);
    expect(result.output).not.toContain('config.refused');
  }, 30_000);

  it('with NODE_ENV unset (the default for `npm run start:http` locally) nothing is enforced either', async () => {
    const env = { PATH: process.env.PATH ?? '', MCP_HTTP_PORT: freePort(), AIWORKPAY_BASE_URL: 'http://localhost:3000' };
    const result = await start(env);
    expect(result.started, result.output).toBe(true);
  }, 30_000);
});
