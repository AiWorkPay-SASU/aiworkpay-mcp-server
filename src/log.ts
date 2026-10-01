/**
 * Structured logs, one JSON object per line on stderr: with the stdio
 * transport, stdout carries the MCP protocol and must stay clean.
 *
 * Never pass the API key or mission contents here — identifiers, codes and
 * timings only.
 */
type Level = 'info' | 'warn' | 'error';

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`);
}
