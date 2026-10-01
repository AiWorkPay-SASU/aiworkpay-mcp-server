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
        details: error.details,
      });
    }
    log('error', 'tool.crashed', { tool, error: error instanceof Error ? error.message : String(error) });
    return failure({ code: 'INTERNAL_ERROR', message: 'Unexpected error in the AIWorkPay MCP server.', source: 'mcp_server' });
  }
}
