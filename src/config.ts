import { z } from 'zod';

const booleanFlag = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const commaList = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean));

const sharedSchema = z.object({
  AIWORKPAY_BASE_URL: z
    .string()
    .url()
    .refine((url) => url.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url), {
      message: 'must use https (http is only accepted for localhost)',
    })
    .transform((url) => url.replace(/\/+$/, '')),
  AIWORKPAY_MAX_MISSION_BUDGET: z.coerce.number().positive().default(50),
  AIWORKPAY_ALLOWED_CURRENCIES: z
    .string()
    .default('EUR')
    .transform((value) => value.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^[A-Z]{3}$/, 'currencies are ISO 4217 codes, e.g. EUR')).min(1)),
  AIWORKPAY_REQUIRE_CONFIRMATION: booleanFlag.default('true'),
  AIWORKPAY_MAX_CREATIONS_PER_HOUR: z.coerce.number().int().nonnegative().default(10),
  AIWORKPAY_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
});

const apiKeySchema = z.object({
  AIWORKPAY_API_KEY: z.string().startsWith('awp_', { message: 'must be an AIWorkPay agent key (awp_...)' }),
});

const httpSchema = z.object({
  MCP_HTTP_HOST: z.string().default('127.0.0.1'),
  MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  MCP_ALLOWED_HOSTS: commaList('localhost,127.0.0.1'),
  MCP_ALLOWED_ORIGINS: commaList(''),
});

/** Settings shared by every transport: where AIWorkPay is and the safety limits. */
export interface ServerConfig {
  baseUrl: string;
  /** Highest budget of a single mission, in the mission's currency. */
  maxMissionBudget: number;
  allowedCurrencies: string[];
  /** When true, money-moving tools only preview unless called with confirm: true. */
  requireConfirmation: boolean;
  /** Missions created per rolling hour, per agent key; 0 disables creation. */
  maxCreationsPerHour: number;
  timeoutMs: number;
}

/** stdio: one agent per process, its key comes from the environment. */
export interface Config extends ServerConfig {
  apiKey: string;
}

/** Streamable HTTP: many agents, each request carries its own key. */
export interface HttpConfig extends ServerConfig {
  host: string;
  port: number;
  /** Accepted Host header names (without port): protects against DNS rebinding. */
  allowedHosts: string[];
  /** Accepted browser origins; requests without an Origin header are not affected. */
  allowedOrigins: string[];
}

export class ConfigError extends Error {}

function parse<T extends z.ZodTypeAny>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  return parsed.data;
}

function serverConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const c = parse(sharedSchema, env);
  return {
    baseUrl: c.AIWORKPAY_BASE_URL,
    maxMissionBudget: c.AIWORKPAY_MAX_MISSION_BUDGET,
    allowedCurrencies: c.AIWORKPAY_ALLOWED_CURRENCIES,
    requireConfirmation: c.AIWORKPAY_REQUIRE_CONFIRMATION,
    maxCreationsPerHour: c.AIWORKPAY_MAX_CREATIONS_PER_HOUR,
    timeoutMs: c.AIWORKPAY_TIMEOUT_MS,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const shared = serverConfig(env);
  return { ...shared, apiKey: parse(apiKeySchema, env).AIWORKPAY_API_KEY };
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const shared = serverConfig(env);
  const h = parse(httpSchema, { ...env, MCP_HTTP_PORT: env.MCP_HTTP_PORT ?? env.PORT });
  return {
    ...shared,
    host: h.MCP_HTTP_HOST,
    port: h.MCP_HTTP_PORT,
    allowedHosts: h.MCP_ALLOWED_HOSTS.map((host) => host.toLowerCase()),
    allowedOrigins: h.MCP_ALLOWED_ORIGINS,
  };
}

