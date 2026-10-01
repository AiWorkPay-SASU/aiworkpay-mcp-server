import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AiworkpayClient } from '../api/client.js';
import type { ServerConfig } from '../config.js';
import { missionView } from '../domain/missionStatus.js';
import { log } from '../log.js';
import { GuardError } from '../safety/spendGuard.js';
import { ok, runTool } from './result.js';

/** Must match MAX_REVISIONS in Aiworkpay-v2 (lib/missionLifecycle.ts). */
const MAX_REVISIONS = 3;
const PAYWORKER_SHARE = 0.9;

const missionId = z.string().trim().min(1).max(100).describe('The mission_id returned by create_mission.');

const confirm = z
  .boolean()
  .default(false)
  .describe('false (default): preview only, nothing changes. true: do it.');

export function registerReviewTools(server: McpServer, deps: { client: AiworkpayClient; config: ServerConfig }): void {
  const { client, config } = deps;
  const twoSteps = config.requireConfirmation
    ? 'Two steps: call with confirm=false for a preview, then again with confirm=true. '
    : '';

  server.registerTool(
    'approve_result',
    {
      title: 'Approve a delivered result',
      description:
        'Accept the result of a delivered mission. This pays the Payworker (90% of the budget; 10% AIWorkPay fee) ' +
        'and cannot be undone. Read get_mission_result and check it first; if it is not acceptable, use request_changes instead. ' +
        twoSteps,
      inputSchema: { mission_id: missionId, confirm },
      annotations: {
        title: 'Approve result',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    ({ mission_id, confirm: confirmed }) =>
      runTool('approve_result', async () => {
        if (config.requireConfirmation && !confirmed) {
          const view = missionView(await client.getMission(mission_id));
          if (view.status === 'completed') {
            return ok({ mission_id, status: 'completed', already_approved: true, next_action: 'Nothing to do: already approved and paid.' });
          }
          if (view.status !== 'delivered') {
            throw new GuardError('MISSION_NOT_DELIVERED', `Only a delivered mission can be approved (status: ${view.status}).`, {
              status: view.status,
              next_action: view.next_action,
            });
          }
          return ok({
            status: 'preview',
            approved: false,
            mission_id,
            title: view.title,
            budget: view.budget,
            currency: view.currency,
            payworker_receives: Math.round(view.budget * PAYWORKER_SHARE * 100) / 100,
            irreversible: true,
            next_action: 'If the result is acceptable, call approve_result again with confirm=true. Otherwise use request_changes.',
          });
        }

        const approved = await client.approveMission(mission_id);
        const view = missionView(approved.mission);
        log('info', 'mission.approved', { mission_id, already_approved: approved.alreadyApproved });
        return ok({
          mission_id,
          status: view.status,
          approved: true,
          already_approved: approved.alreadyApproved,
          payworker_paid: approved.commission?.payworkerAmount ?? null,
          platform_fee: approved.commission?.platformFeeAmount ?? null,
          currency: view.currency,
          payout_status: approved.commission ? approved.commission.transferStatus.toLowerCase() : null,
          next_action: 'Done. Continue your workflow with the result.',
        });
      })
  );

  server.registerTool(
    'request_changes',
    {
      title: 'Request changes on a delivered result',
      description:
        'Send a delivered result back to the same Payworker with what is missing or wrong. No money moves. ' +
        `At most ${MAX_REVISIONS} times per mission; after that, approve it or contact the AIWorkPay team.`,
      inputSchema: {
        mission_id: missionId,
        feedback: z
          .string()
          .trim()
          .min(10)
          .max(5000)
          .describe('Precise, polite instructions for the Payworker: what to redo or add. Written for a human.'),
      },
      annotations: {
        title: 'Request changes',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ mission_id, feedback }) =>
      runTool('request_changes', async () => {
        const result = await client.requestChanges(mission_id, feedback);
        const view = missionView(result.mission);
        log('info', 'mission.changes_requested', { mission_id, revisions_left: result.revisionsLeft });
        return ok({
          mission_id,
          status: view.status,
          revisions_requested: view.revisions_requested,
          revisions_left: result.revisionsLeft,
          next_action: 'The Payworker will deliver again. Poll get_mission_status until it is delivered.',
        });
      })
  );

  server.registerTool(
    'cancel_mission',
    {
      title: 'Cancel a mission',
      description:
        'Withdraw a mission no Payworker has taken yet (awaiting_payment or open). An unpaid payment page is closed; ' +
        'a paid mission is refunded. Once a Payworker is engaged it can no longer be canceled here. ' +
        twoSteps,
      inputSchema: { mission_id: missionId, confirm },
      annotations: {
        title: 'Cancel mission',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    ({ mission_id, confirm: confirmed }) =>
      runTool('cancel_mission', async () => {
        if (config.requireConfirmation && !confirmed) {
          const view = missionView(await client.getMission(mission_id));
          if (view.status === 'canceled') {
            return ok({ mission_id, status: 'canceled', already_canceled: true, next_action: 'Nothing to do: already canceled.' });
          }
          if (view.status !== 'awaiting_payment' && view.status !== 'open') {
            throw new GuardError(
              'MISSION_NOT_CANCELABLE',
              `A Payworker is already engaged (status: ${view.status}); only the AIWorkPay team can cancel it.`,
              { status: view.status }
            );
          }
          return ok({
            status: 'preview',
            canceled: false,
            mission_id,
            title: view.title,
            current_status: view.status,
            effect:
              view.status === 'awaiting_payment'
                ? 'The payment page will be closed; nothing was charged.'
                : `The ${view.budget} ${view.currency} paid will be refunded.`,
            irreversible: true,
            next_action: 'To cancel, call cancel_mission again with confirm=true.',
          });
        }

        const result = await client.cancelMission(mission_id);
        log('info', 'mission.canceled', { mission_id, payment: result.payment });
        return ok({
          mission_id,
          status: missionView(result.mission).status,
          canceled: true,
          already_canceled: result.payment === 'already_canceled',
          payment: result.payment,
          next_action: 'Nothing more will happen on this mission.',
        });
      })
  );
}
