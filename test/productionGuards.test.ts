import { describe, expect, it } from 'vitest';
import { checkProductionConfig, productionReport } from '../src/productionGuards.js';

const TOKEN = 'Tok3n-that-must-never-appear-in-a-message-0123456789';
const good = {
  NODE_ENV: 'production',
  AIWORKPAY_BASE_URL: 'https://app.example.fr',
  MCP_ALLOWED_HOSTS: 'mcp.example.fr',
  MCP_TRUSTED_PROXY_HOPS: '1',
  AIWORKPAY_FORWARD_TOKEN: TOKEN,
  MCP_HTTP_HOST: '0.0.0.0',
  AIWORKPAY_MAX_MISSION_BUDGET: '50',
  AIWORKPAY_MAX_CREATIONS_PER_HOUR: '10',
  AIWORKPAY_ALLOWED_CURRENCIES: 'EUR',
};
const problems = (patch: Record<string, string | undefined> = {}) => {
  const env: Record<string, string | undefined> = { ...good, ...patch };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return checkProductionConfig(env).problems;
};

describe('MCP production startup guards', () => {
  it('a complete production configuration passes, with no warning', () => {
    const report = checkProductionConfig(good);
    expect(report.problems).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('the number of proxies must be stated: unset, empty, 0, negative, fractional, text or above 5 are refused; 1 to 5 pass', () => {
    for (const value of [undefined, '', '  ', '0', '-1', '1.5', 'two', '6', '10']) {
      expect(problems({ MCP_TRUSTED_PROXY_HOPS: value }), String(value)).toHaveLength(1);
    }
    for (const value of ['1', '2', '3', '4', '5']) expect(problems({ MCP_TRUSTED_PROXY_HOPS: value })).toEqual([]);
  });

  it('the unset case does not fall back to the schema default of 1: it says so', () => {
    expect(problems({ MCP_TRUSTED_PROXY_HOPS: undefined })[0]).toMatch(/not set.*state how many proxies/);
  });

  it('the shared secret is required, at least 16 characters, and not an unresolved reference or placeholder', () => {
    expect(problems({ AIWORKPAY_FORWARD_TOKEN: undefined })[0]).toMatch(/AIWORKPAY_FORWARD_TOKEN is not set/);
    expect(problems({ AIWORKPAY_FORWARD_TOKEN: 'short' })[0]).toMatch(/shorter than 16/);
    expect(problems({ AIWORKPAY_FORWARD_TOKEN: '0123456789abcde' })[0]).toMatch(/shorter than 16/);
    expect(problems({ AIWORKPAY_FORWARD_TOKEN: '0123456789abcdef' })).toEqual([]);
    expect(problems({ AIWORKPAY_FORWARD_TOKEN: '${{backend.TRUSTED_FORWARDER_TOKEN}}' })[0]).toMatch(/unresolved reference/);
    expect(problems({ AIWORKPAY_FORWARD_TOKEN: '<generate-with-openssl-rand>' })[0]).toMatch(/placeholder/);
  });

  it('the backend address must be a public https URL', () => {
    expect(problems({ AIWORKPAY_BASE_URL: undefined })[0]).toMatch(/AIWORKPAY_BASE_URL is not set/);
    expect(problems({ AIWORKPAY_BASE_URL: 'http://app.example.fr' })[0]).toMatch(/https/);
    for (const local of ['https://localhost:3000', 'https://127.0.0.1', 'https://0.0.0.0', 'https://[::1]:3000']) {
      expect(problems({ AIWORKPAY_BASE_URL: local })[0], local).toMatch(/local address/);
    }
    expect(problems({ AIWORKPAY_BASE_URL: 'not a url' })[0]).toMatch(/not a valid URL/);
  });

  it('the allowed hosts must include a public host: the localhost-only default would refuse every real request', () => {
    expect(problems({ MCP_ALLOWED_HOSTS: undefined })[0]).toMatch(/no public host/);
    expect(problems({ MCP_ALLOWED_HOSTS: 'localhost,127.0.0.1' })[0]).toMatch(/no public host/);
    expect(problems({ MCP_ALLOWED_HOSTS: 'localhost,mcp.example.fr' })).toEqual([]);
  });

  it('dangerous settings are refused: a shared API key, and confirmation switched off', () => {
    expect(problems({ AIWORKPAY_API_KEY: 'awp_whatever' })[0]).toMatch(/AIWORKPAY_API_KEY is set/);
    for (const off of ['false', '0', 'FALSE']) expect(problems({ AIWORKPAY_REQUIRE_CONFIRMATION: off })[0], off).toMatch(/CONFIRMATION is off/);
    for (const on of ['true', '1', undefined]) expect(problems({ AIWORKPAY_REQUIRE_CONFIRMATION: on })).toEqual([]);
  });

  it('defaults that apply silently are reported as warnings, not refused', () => {
    const report = checkProductionConfig({ ...good, AIWORKPAY_MAX_MISSION_BUDGET: undefined, AIWORKPAY_MAX_CREATIONS_PER_HOUR: undefined, AIWORKPAY_ALLOWED_CURRENCIES: undefined, MCP_HTTP_HOST: undefined });
    expect(report.problems).toEqual([]);
    expect(report.warnings).toHaveLength(4);
  });

  it('every problem is reported at once', () => {
    const report = checkProductionConfig({ NODE_ENV: 'production', AIWORKPAY_API_KEY: 'x' });
    expect(report.problems.length).toBeGreaterThanOrEqual(5);
  });

  it('no message ever contains a secret or a configured value', () => {
    const all = [
      ...problems({ AIWORKPAY_FORWARD_TOKEN: TOKEN.slice(0, 10) }),
      ...problems({ AIWORKPAY_API_KEY: 'awp_SECRETKEYVALUE12345', MCP_TRUSTED_PROXY_HOPS: 'weird-value', AIWORKPAY_BASE_URL: 'http://user:pass@secret-host.example/x' }),
      ...checkProductionConfig({ ...good, AIWORKPAY_BASE_URL: undefined, AIWORKPAY_API_KEY: 'awp_SECRETKEYVALUE12345' }).warnings,
    ].join('\n');
    for (const secret of [TOKEN, TOKEN.slice(0, 10), 'awp_SECRETKEYVALUE12345', 'weird-value', 'user:pass', 'secret-host.example']) expect(all).not.toContain(secret);
  });

  it('development, tests and unset NODE_ENV are untouched: no guard applies, whatever the settings', () => {
    for (const nodeEnv of [undefined, 'development', 'test', 'staging']) {
      expect(productionReport({ NODE_ENV: nodeEnv, AIWORKPAY_API_KEY: 'x', AIWORKPAY_REQUIRE_CONFIRMATION: 'false' })).toBeNull();
    }
    expect(productionReport({ NODE_ENV: 'production' })).not.toBeNull();
  });
});
