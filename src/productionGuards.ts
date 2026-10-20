/**
 * Refuses to start the HTTP server in production with a configuration that silently weakens it.
 *
 * Nothing is guessed: the number of proxies in front of the server is the operator's to state (the schema's default of 1 is
 * kept for development, where nothing sits in front). Only the NAMES of settings appear in the messages, never a value, so a
 * refusal can be copied into a ticket without leaking the shared secret.
 *
 * Applies when NODE_ENV=production (the Dockerfile sets it) and only to the HTTP entry point (src/httpMain.ts): development, tests
 * and the stdio transport are untouched.
 */
import { createHash } from 'node:crypto';

export interface ConfigReport {
  problems: string[];
  warnings: string[];
}

type Env = Record<string, string | undefined>;

const MIN_FORWARD_TOKEN_LENGTH = 16;
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/i;

export function checkProductionConfig(env: Env = process.env): ConfigReport {
  const problems: string[] = [];
  const warnings: string[] = [];
  const set = (name: string): boolean => typeof env[name] === 'string' && env[name]!.trim() !== '';

  // How many proxies stand in front: stated, never implied
  if (!set('MCP_TRUSTED_PROXY_HOPS')) {
    problems.push(
      'MCP_TRUSTED_PROXY_HOPS is not set: state how many proxies stand in front of this server (an integer 1-5: 1 behind Railway alone, 2 with Cloudflare in front). ' +
        'Without it a client can forge X-Forwarded-For and dodge the failed-authentication limit. It can differ from the backend\'s own setting.',
    );
  } else if (!/^[1-5]$/.test(env.MCP_TRUSTED_PROXY_HOPS!.trim())) {
    problems.push('MCP_TRUSTED_PROXY_HOPS must be an integer from 1 to 5 (the number of proxies in front of this server).');
  }

  // The secret shared with the backend: present, long enough, resolved
  const token = env.AIWORKPAY_FORWARD_TOKEN ?? '';
  if (!set('AIWORKPAY_FORWARD_TOKEN')) {
    problems.push(
      'AIWORKPAY_FORWARD_TOKEN is not set: without the secret shared with the backend (its TRUSTED_FORWARDER_TOKEN), every agent would be counted under this server\'s own address ' +
        'and one attacker could lock all of them out.',
    );
  } else if (token.includes('${{') || /<[^>]*>/.test(token)) {
    problems.push('AIWORKPAY_FORWARD_TOKEN still looks like an unresolved reference or placeholder: check the Railway reference to the backend variable.');
  } else if (token.length < MIN_FORWARD_TOKEN_LENGTH) {
    problems.push(`AIWORKPAY_FORWARD_TOKEN is shorter than ${MIN_FORWARD_TOKEN_LENGTH} characters.`);
  }

  // The backend this server talks to
  if (!set('AIWORKPAY_BASE_URL')) {
    problems.push('AIWORKPAY_BASE_URL is not set: give the public HTTPS address of the AIWorkPay backend.');
  } else {
    try {
      const url = new URL(env.AIWORKPAY_BASE_URL!);
      if (url.protocol !== 'https:') problems.push('AIWORKPAY_BASE_URL must use https in production.');
      else if (LOCAL_HOST.test(url.hostname)) problems.push('AIWORKPAY_BASE_URL points at a local address: give the backend\'s public HTTPS address.');
    } catch {
      problems.push('AIWORKPAY_BASE_URL is not a valid URL.');
    }
  }

  // Host header protection: the default accepts only localhost, which would refuse every real request
  const hosts = (env.MCP_ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean);
  if (!hosts.some((host) => !LOCAL_HOST.test(host))) {
    problems.push('MCP_ALLOWED_HOSTS lists no public host (the default accepts only localhost): set it to this server\'s public host name(s), e.g. mcp.aiworkpay.fr.');
  }

  // Dangerous settings
  if (set('AIWORKPAY_API_KEY')) {
    problems.push('AIWORKPAY_API_KEY is set: in HTTP mode each agent brings its own key. A shared key would give every caller the same identity and the same spending rights. Remove it.');
  }
  if (/^(false|0)$/i.test((env.AIWORKPAY_REQUIRE_CONFIRMATION ?? '').trim())) {
    problems.push('AIWORKPAY_REQUIRE_CONFIRMATION is off: create_mission, approve_result and cancel_mission would act without the preview-then-confirm step. Remove it or set it to true.');
  }

  // Not refused, but worth seeing in the log
  if (!set('AIWORKPAY_MAX_MISSION_BUDGET')) warnings.push('AIWORKPAY_MAX_MISSION_BUDGET is not set: the default operator cap (50 per mission) applies.');
  if (!set('AIWORKPAY_MAX_CREATIONS_PER_HOUR')) warnings.push('AIWORKPAY_MAX_CREATIONS_PER_HOUR is not set: the default (10 creations per hour per agent) applies.');
  if (!set('AIWORKPAY_ALLOWED_CURRENCIES')) warnings.push('AIWORKPAY_ALLOWED_CURRENCIES is not set: the default (EUR) applies.');
  if (!set('MCP_HTTP_HOST') || /^(127\.|localhost|\[?::1)/i.test((env.MCP_HTTP_HOST ?? '').trim())) {
    warnings.push('MCP_HTTP_HOST is the loopback address or unset: a container must listen on 0.0.0.0 (the Dockerfile sets it).');
  }

  return { problems, warnings };
}

/** Returns the report when production rules apply, or null (development, tests, anything but NODE_ENV=production). */
export function productionReport(env: Env = process.env): ConfigReport | null {
  return env.NODE_ENV === 'production' ? checkProductionConfig(env) : null;
}

/**
 * Eight hex characters of the SHA-256 of AIWORKPAY_FORWARD_TOKEN, computed exactly like the backend's startup log (`forwarder secret
 * fingerprint`): the operator compares the two lines to confirm both services hold the same secret, without either log ever containing
 * it. A mismatch is otherwise silent. Reveals nothing of a random secret of 16+ characters.
 */
export function forwarderFingerprint(env: Env = process.env): string | null {
  const token = env.AIWORKPAY_FORWARD_TOKEN;
  return token ? createHash('sha256').update(token).digest('hex').slice(0, 8) : null;
}
