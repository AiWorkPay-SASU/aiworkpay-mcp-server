import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AiworkpayApiError } from '../api/client.js';
import { log } from '../log.js';
import { GuardError } from '../safety/spendGuard.js';

export function ok(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function failure(error: Record<string, unknown>): CallToolResult {
  const payload = { error };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/** What the agent can do about errors it cannot fix by itself. */
const HINTS: Record<string, string> = {
  INSUFFICIENT_SCOPE: 'Your API key does not allow this action. Ask your human owner for a key with the required scope.',
  INVALID_API_KEY: 'The API key is invalid, expired or revoked. Ask your human owner for a new key.',
  BUDGET_LIMIT_EXCEEDED: 'The budget exceeds the per-mission cap of your API key. Lower it or ask your owner to raise the cap.',
  MONTHLY_BUDGET_EXCEEDED: 'The monthly budget of your API key is used up. Wait for next month or ask your owner to raise it.',
  RATE_LIMITED: 'Too many requests. Wait retry_after_seconds before trying again.',
};

const RETRYABLE = new Set(['TIMEOUT', 'NETWORK_ERROR', 'PAYMENT_PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'INTERNAL_ERROR']);

/** Run a tool body and turn known failures into tool errors the agent can act on. */
export async function runTool(tool: string, body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof GuardError) {
      log('warn', 'tool.refused', { tool, code: error.code });
      return failure({ code: error.code, message: error.message, source: 'mcp_server', ...error.details });
    }
    if (error instanceof AiworkpayApiError) {
      log('warn', 'tool.api_error', { tool, code: error.code, status: error.status, request_id: error.requestId });
      return failure({
        code: error.code,
        message: error.message,
        source: 'aiworkpay_api',
        http_status: error.status || undefined,
        request_id: error.requestId,
        retryable: RETRYABLE.has(error.code) || error.status >= 500,
        retry_after_seconds: error.retryAfterSeconds,
        hint: HINTS[error.code],
        details: error.details,
      });
    }
    log('error', 'tool.crashed', { tool, error: error instanceof Error ? error.message : String(error) });
    return failure({ code: 'INTERNAL_ERROR', message: 'Unexpected error in the AIWorkPay MCP server.', source: 'mcp_server' });
  }
}
