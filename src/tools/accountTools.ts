import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AiworkpayClient } from '../api/client.js';
import type { ServerConfig } from '../config.js';
import type { MissionStatus } from '../api/types.js';
import { toAgentStatus, type AgentStatus } from '../domain/missionStatus.js';
import type { CreationLimiter } from '../safety/creationLimiter.js';
import { ok, runTool } from './result.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** Missions per agent status; the API's CREATED and PAYMENT_PENDING both read as awaiting_payment. */
function countByAgentStatus(byStatus: Partial<Record<MissionStatus, number>>): Partial<Record<AgentStatus, number>> {
  const counts: Partial<Record<AgentStatus, number>> = {};
  for (const [status, count] of Object.entries(byStatus) as [MissionStatus, number][]) {
    const agentStatus = toAgentStatus(status);
    counts[agentStatus] = (counts[agentStatus] ?? 0) + count;
  }
  return counts;
}

export function registerAccountTools(
  server: McpServer,
  deps: { client: AiworkpayClient; config: ServerConfig; limiter: CreationLimiter }
): void {
  const { client, config, limiter } = deps;

  server.registerTool(
    'get_account',
    {
      title: 'Get my account',
      description:
        'Your own account: what your API key may do, its spending caps, the budget used and left this month, ' +
        'what you paid and was refunded, your missions by status, and the largest mission you can create right now ' +
        '(effective_max_budget). Check it before ordering something expensive.',
      inputSchema: {},
      annotations: { title: 'Get account', ...READ_ONLY },
    },
    () =>
      runTool('get_account', async () => {
        const account = await client.getAccount();
        const scopes = account.key.scopes;
        const canCreate = scopes.includes('missions:write');

        // The smallest of every ceiling that applies to the next creation
        const ceilings = [config.maxMissionBudget, account.limits.maxMissionBudget, account.usage.remainingThisMonth].filter(
          (value): value is number => value !== null
        );
        const effectiveMax = Math.min(...ceilings);
        const creationsLeft = limiter.available();

        return ok({
          agent: {
            label: account.key.label,
            key_prefix: account.key.prefix,
            active: account.key.active,
            expires_at: account.key.expiresAt,
            last_used_at: account.key.lastUsedAt,
          },
          permissions: {
            scopes,
            can_read: scopes.includes('missions:read'),
            can_create_and_cancel: canCreate,
            can_approve_and_review: scopes.includes('missions:approve'),
          },
          limits: {
            max_mission_budget: account.limits.maxMissionBudget,
            monthly_budget: account.limits.monthlyBudget,
          },
          usage: {
            month_starts_at: account.usage.monthStart,
            committed_this_month: account.usage.committedThisMonth,
            remaining_this_month: account.usage.remainingThisMonth,
            total_paid: account.usage.totalPaid,
            total_refunded: account.usage.totalRefunded,
            net_paid: account.usage.netPaid,
          },
          missions: { total: account.missions.total, by_status: countByAgentStatus(account.missions.byStatus) },
          operator_limits: {
            max_mission_budget: config.maxMissionBudget,
            allowed_currencies: config.allowedCurrencies,
            require_confirmation: config.requireConfirmation,
            creations_per_hour: config.maxCreationsPerHour,
            creations_available_now: creationsLeft,
          },
          can_create_now: canCreate && account.key.active && effectiveMax > 0 && creationsLeft > 0,
          effective_max_budget: effectiveMax,
          webhook_configured: account.webhook.configured,
        });
      })
  );

  server.registerTool(
    'list_transactions',
    {
      title: 'List my payments',
      description:
        'The payments made with your key, most recent first: amount, currency, the mission, and whether it was ' +
        'refunded (the mission was canceled). Optionally for one mission.',
      inputSchema: {
        mission_id: z.string().trim().min(1).max(100).optional().describe('Only the payments of this mission.'),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { title: 'List transactions', ...READ_ONLY },
    },
    ({ mission_id, limit, offset }) =>
      runTool('list_transactions', async () => {
        const { total, transactions } = await client.listTransactions({ missionId: mission_id, limit, skip: offset });
        return ok({
          transactions: transactions.map((t) => ({
            transaction_id: t.id,
            type: 'payment',
            status: t.status.toLowerCase(),
            amount: t.amount,
            currency: t.currency,
            mission_id: t.missionId,
            mission_status: t.missionStatus ? toAgentStatus(t.missionStatus) : null,
            refunded: t.refunded,
            created_at: t.createdAt,
          })),
          count: transactions.length,
          total,
          next_offset: offset + transactions.length < total ? offset + transactions.length : null,
        });
      })
  );
}
