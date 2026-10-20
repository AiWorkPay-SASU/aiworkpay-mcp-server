#!/usr/bin/env node
/**
 * Read-only smoke test of a deployed AIWorkPay MCP server (Streamable HTTP).
 *
 *   node scripts/smoke-remote.mjs https://mcp.aiworkpay.fr
 *   AIWORKPAY_API_KEY=awp_... node scripts/smoke-remote.mjs https://mcp.aiworkpay.fr     # also checks an authenticated session
 *
 * It creates nothing, approves nothing, pays nothing: only the health check, refusals, `initialize`, `tools/list` and,
 * with a key, the read-only `get_account`. Use a key of a test agent, never a key with spending power you do not need.
 * Exit code 1 when a check fails.
 */
const target = (process.argv[2] ?? process.env.MCP_URL ?? '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(target)) {
  console.error('Usage: node scripts/smoke-remote.mjs <https://host> (the server root, without /mcp)');
  process.exit(2);
}
const key = process.env.AIWORKPAY_API_KEY;
const EXPECTED_TOOLS = ['approve_result', 'cancel_mission', 'create_mission', 'get_account', 'get_mission', 'get_mission_result', 'get_mission_status',
  'get_proof_file', 'get_workforce_handoff', 'list_missions', 'list_transactions', 'prepare_workforce_handoff', 'request_changes'];

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failed += 1; };
const rpc = (body, headers = {}) => fetch(`${target}/mcp`, {
  method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const readJson = async (response) => { try { return await response.json(); } catch { return null; } };
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'aiworkpay-smoke', version: '1.0.0' } } };

console.log(`Smoke test of ${target}${key ? ' (with an API key)' : ' (no key: authenticated checks skipped)'}\n`);

try {
  if (target.startsWith('https://')) {
    const plain = await fetch(target.replace('https://', 'http://') + '/healthz', { redirect: 'manual', signal: AbortSignal.timeout(10000) }).catch(() => null);
    check('plain HTTP is not served: it redirects to HTTPS or refuses to connect', !plain || (plain.status >= 300 && plain.status < 400) || plain.status === 403 || plain.status === 404, plain ? `status ${plain.status}` : 'connection refused');
  }

  const health = await fetch(`${target}/healthz`, { signal: AbortSignal.timeout(15000) });
  check('GET /healthz answers 200 {"status":"ok"}', health.status === 200 && (await readJson(health))?.status === 'ok', `status ${health.status}`);
  check('GET /nothing answers 404', (await fetch(`${target}/nothing`)).status === 404);

  const verb = await fetch(`${target}/mcp`, { method: 'GET', headers: { accept: 'text/event-stream' } });
  check('GET /mcp is refused (stateless server): 405 with Allow: POST', verb.status === 405 && /POST/.test(verb.headers.get('allow') ?? ''), `status ${verb.status}`);

  const anonymous = await rpc(initialize);
  const anonymousBody = await readJson(anonymous);
  check('POST /mcp without a key answers 401 with a JSON-RPC error', anonymous.status === 401 && anonymousBody?.error?.code === -32001, `status ${anonymous.status}`);
  check('the 401 carries a WWW-Authenticate: Bearer header', /Bearer/i.test(anonymous.headers.get('www-authenticate') ?? ''));

  const foreign = await rpc(initialize, { origin: 'https://evil.example', authorization: `Bearer awp_${'a'.repeat(24)}` });
  check('a browser Origin that is not allowed is refused (403)', foreign.status === 403, `status ${foreign.status}`);

  const malformed = await rpc('{not json', { authorization: `Bearer awp_${'a'.repeat(24)}` });
  const malformedBody = await readJson(malformed);
  check('malformed JSON answers 400 with JSON-RPC parse error -32700', malformed.status === 400 && malformedBody?.error?.code === -32700, `status ${malformed.status}`);

  const basic = await rpc(initialize, { authorization: 'Basic YXdwOng=' });
  check('another authentication scheme is refused (401)', basic.status === 401);

  if (key) {
    const auth = { authorization: `Bearer ${key}` };
    const init = await rpc(initialize, auth);
    const initBody = await readJson(init);
    check('initialize succeeds with the key', init.status === 200 && !!initBody?.result?.serverInfo, `status ${init.status}`);
    if (initBody?.result?.serverInfo) console.log(`         server: ${initBody.result.serverInfo.name} ${initBody.result.serverInfo.version}, protocol ${initBody.result.protocolVersion}`);

    const list = await readJson(await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth));
    const names = (list?.result?.tools ?? []).map((t) => t.name).sort();
    check(`tools/list lists the ${EXPECTED_TOOLS.length} documented tools`, JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), `got ${names.length}: ${names.filter((n) => !EXPECTED_TOOLS.includes(n)).join(',') || 'no extra'}; missing: ${EXPECTED_TOOLS.filter((n) => !names.includes(n)).join(',') || 'none'}`);

    const account = await readJson(await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_account', arguments: {} } }, auth));
    const content = account?.result?.structuredContent;
    check('get_account (read-only) reaches AIWorkPay and answers for this key', !!content?.agent?.key_prefix && account.result.isError !== true, account?.result?.isError ? JSON.stringify(account.result.structuredContent?.error) : '');
    if (content) console.log(`         agent "${content.agent.label}", can create now: ${content.can_create_now}, largest mission: ${content.effective_max_budget}`);

    const unknownTool = await readJson(await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'does_not_exist', arguments: {} } }, auth));
    check('an unknown tool is an error, not a crash', !!unknownTool?.error || unknownTool?.result?.isError === true);
    const unknownMethod = await readJson(await rpc({ jsonrpc: '2.0', id: 5, method: 'nope/nothing' }, auth));
    check('an unknown JSON-RPC method answers -32601', unknownMethod?.error?.code === -32601, JSON.stringify(unknownMethod?.error ?? {}).slice(0, 80));
  }
} catch (error) {
  failed += 1;
  console.log(` FAIL  the server could not be reached: ${error.message}`);
}

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
