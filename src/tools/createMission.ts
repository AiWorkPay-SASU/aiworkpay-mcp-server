import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AiworkpayClient } from '../api/client.js';
import type { ServerConfig } from '../config.js';
import { idempotencyKeyFor, MISSION_TYPES, toCreateRequest } from '../domain/missionInput.js';
import { missionView } from '../domain/missionStatus.js';
import { log } from '../log.js';
import type { CreationLimiter } from '../safety/creationLimiter.js';
import { assertSpendAllowed, GuardError } from '../safety/spendGuard.js';
import { ok, runTool } from './result.js';

export const createMissionInputSchema = {
  type: z.enum(MISSION_TYPES).describe('Kind of task delegated to a human.'),
  title: z.string().trim().min(3).max(200).describe('Short title shown on the marketplace.'),
  instructions: z
    .string()
    .trim()
    .min(10)
    .max(8000)
    .describe('What the Payworker must do, precisely. Written for a human; French or English.'),
  location: z
    .object({
      city: z.string().max(200).optional(),
      address: z.string().max(500).optional(),
      country: z.string().max(100).optional(),
      details: z.string().max(1000).optional(),
    })
    .optional()
    .describe('Where the task happens, for physical tasks.'),
  deliverables: z
    .array(z.string().trim().min(1).max(300))
    .max(20)
    .optional()
    .describe('What the Payworker must deliver, e.g. "photo of the storefront", "opening hours", "date and time of the visit".'),
  budget: z
    .number()
    .positive()
    .multipleOf(0.01)
    .describe('Total price paid for the mission, in `currency`. The Payworker receives 90%.'),
  currency: z.string().regex(/^[A-Za-z]{3}$/).describe('ISO 4217 code, e.g. EUR.'),
  deadline: z.string().datetime({ offset: true }).describe('ISO 8601 date-time with offset, in the future.'),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  client_reference: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Your own identifier for this mission (e.g. "verify-shop-42"). Calling again with the same reference never creates a second mission. ' +
        'Without it, an identical request is also deduplicated: set distinct references to order the same task twice on purpose.'
    ),
  confirm: z
    .boolean()
    .default(false)
    .describe('false (default): preview only, nothing is created. true: create the mission and open its payment.'),
};

export function registerCreateMission(
  server: McpServer,
  deps: { client: AiworkpayClient; config: ServerConfig; limiter: CreationLimiter }
): void {
  const { client, config, limiter } = deps;

  server.registerTool(
    'create_mission',
    {
      title: 'Create a mission for the AIWorkPay human workforce',
      description:
        'Delegate to a human Payworker a task you cannot do yourself: on-site verification, photos, phone calls, ' +
        'local data collection, document checks. ' +
        (config.requireConfirmation
          ? 'Two steps: call with confirm=false to get a preview of what will be ordered and charged, then call again with the same arguments and confirm=true. '
          : '') +
        'Creating the mission spends nothing by itself: it returns payment_url, a Stripe payment page that your human owner must pay. ' +
        'The mission is published to Payworkers only once paid. Then poll get_mission_status and read get_mission_result. ' +
        `Limits on this server: budget at most ${config.maxMissionBudget} per mission, currencies ${config.allowedCurrencies.join(', ')}.`,
      inputSchema: createMissionInputSchema,
      annotations: {
        title: 'Create mission',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) =>
      runTool('create_mission', async () => {
        assertSpendAllowed(args, config);
        const request = toCreateRequest(args);

        if (config.requireConfirmation && !args.confirm) {
          return ok({
            status: 'preview',
            created: false,
            charged: false,
            mission: {
              title: request.title,
              description: request.description,
              budget: request.budget,
              currency: request.currency,
              deadline: request.deadline,
              priority: args.priority,
            },
            payment: 'A Stripe payment page will be returned; a human must pay it before the mission is published.',
            next_action: 'Check the preview. To order it, call create_mission again with the same arguments and confirm=true.',
          });
        }

        const idempotencyKey = idempotencyKeyFor(args, request);
        const retryAfter = limiter.reserve(idempotencyKey);
        if (retryAfter > 0) {
          throw new GuardError(
            'CREATION_LIMIT_REACHED',
            `This server allows ${config.maxCreationsPerHour} new missions per hour.`,
            Number.isFinite(retryAfter) ? { retry_after_seconds: retryAfter } : {}
          );
        }

        let created;
        try {
          created = await client.createMission(request, idempotencyKey);
        } finally {
          // An uncertain outcome still consumes a slot; the same reference can retry.
          limiter.record(idempotencyKey);
        }

        const view = missionView(created.mission);
        log('info', 'mission.created', { mission_id: view.mission_id, replayed: created.replayed, status: view.status });

        const payment = created.payment?.mode === 'checkout' ? created.payment : null;
        return ok({
          ...view,
          created: true,
          already_existed: created.replayed,
          payment_url: view.status === 'awaiting_payment' ? (payment?.url ?? view.payment_url) : null,
          payment_url_expires_at:
            view.status === 'awaiting_payment' ? (payment?.expiresAt ?? view.payment_url_expires_at) : null,
        });
      })
  );
}
