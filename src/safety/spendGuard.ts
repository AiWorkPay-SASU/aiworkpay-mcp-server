import type { Config } from '../config.js';
import type { MissionInput } from '../domain/missionInput.js';

/** A request refused by this server before anything is sent to AIWorkPay. */
export class GuardError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'GuardError';
  }
}

/**
 * Checks applied before any spend. AIWorkPay's own checks still apply after
 * these: this layer only narrows what the agent may do.
 */
export function assertSpendAllowed(
  input: Pick<MissionInput, 'budget' | 'currency' | 'deadline'>,
  config: Pick<Config, 'maxMissionBudget' | 'allowedCurrencies'>,
  now = new Date()
): void {
  const currency = input.currency.toUpperCase();
  if (!config.allowedCurrencies.includes(currency)) {
    throw new GuardError('CURRENCY_NOT_ALLOWED', `Currency ${currency} is not allowed on this server.`, {
      allowed_currencies: config.allowedCurrencies,
    });
  }

  if (input.budget > config.maxMissionBudget) {
    throw new GuardError(
      'BUDGET_CAP_EXCEEDED',
      `The budget ${input.budget} ${currency} exceeds the cap of ${config.maxMissionBudget} per mission set by this server's operator.`,
      { max_mission_budget: config.maxMissionBudget }
    );
  }

  if (new Date(input.deadline).getTime() <= now.getTime()) {
    throw new GuardError('DEADLINE_IN_THE_PAST', 'The deadline must be in the future.');
  }
}
