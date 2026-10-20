import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SERVER_VERSION } from '../src/server.js';

describe('server.json (MCP registry entry)', () => {
  const entry = JSON.parse(readFileSync('server.json', 'utf8'));

  it('follows the registry rules we rely on', () => {
    expect(entry.$schema).toMatch(/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/[\d-]+\/server\.schema\.json$/);
    expect(entry.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(entry.description.length).toBeLessThanOrEqual(100);
    expect(entry.title.length).toBeLessThanOrEqual(100);
  });

  it('declares the version of the package and a single HTTPS Streamable HTTP endpoint secured by a secret header', () => {
    expect(entry.version).toBe(SERVER_VERSION);
    expect(entry.remotes).toHaveLength(1);
    const [remote] = entry.remotes;
    expect(remote).toMatchObject({ type: 'streamable-http', url: 'https://mcp.aiworkpay.fr/mcp' });
    expect(remote.headers).toHaveLength(1);
    expect(remote.headers[0]).toMatchObject({ name: 'Authorization', isRequired: true, isSecret: true });
    expect(remote.headers[0].value).toBe('Bearer {api_key}');
    expect(remote.headers[0].variables.api_key).toMatchObject({ isRequired: true, isSecret: true });
  });

  it('does not expose the private repository or any secret', () => {
    expect(entry.repository).toBeUndefined();
    expect(JSON.stringify(entry)).not.toMatch(/github\.com|awp_[a-f0-9]{20,}|sk_live|sk_test/);
  });
});
