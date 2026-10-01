import { z } from 'zod';

const booleanFlag = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const configSchema = z.object({
  AIWORKPAY_BASE_URL: z
    .string()
    .url()
    .refine((url) => url.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url), {
      message: 'must use https (http is only accepted for localhost)',
    })
    .transform((url) => url.replace(/\/+$/, '')),
  AIWORKPAY_API_KEY: z.string().startsWith('awp_', { message: 'must be an AIWorkPay agent key (awp_...)' }),
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

export interface Config {
  baseUrl: string;
  apiKey: string;
  /** Highest budget of a single mission, in the mission's currency. */
  maxMissionBudget: number;
  allowedCurrencies: string[];
  /** When true, create_mission only previews unless called with confirm: true. */
  requireConfirmation: boolean;
  /** Missions this server may create per rolling hour; 0 disables creation. */
  maxCreationsPerHour: number;
  timeoutMs: number;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const c = parsed.data;
  return {
    baseUrl: c.AIWORKPAY_BASE_URL,
    apiKey: c.AIWORKPAY_API_KEY,
    maxMissionBudget: c.AIWORKPAY_MAX_MISSION_BUDGET,
    allowedCurrencies: c.AIWORKPAY_ALLOWED_CURRENCIES,
    requireConfirmation: c.AIWORKPAY_REQUIRE_CONFIRMATION,
    maxCreationsPerHour: c.AIWORKPAY_MAX_CREATIONS_PER_HOUR,
    timeoutMs: c.AIWORKPAY_TIMEOUT_MS,
  };
}
