import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AiworkpayClient } from '../api/client.js';
import type { ServerConfig } from '../config.js';
import { assertSpendAllowed } from '../safety/spendGuard.js';
import { createMissionInputSchema } from './createMission.js';
import { missionView } from '../domain/missionStatus.js';
import { missionResultView } from './readMissions.js';
import { ok, runTool } from './result.js';

// A function, not a shared instance: a reused schema is emitted as a `$ref`, which several agent frameworks cannot resolve
const identifier = () => z.string().trim().min(1).max(200);
const contextSchema = z.object({
  swarm_id: identifier(),
  task_id: identifier(),
  handoff_id: identifier().default('primary').describe('Stable identifier per human subtask. Reuse on retry; change for a distinct mission.'),
}).strict();
const { confirm: _confirm, client_reference: _reference, ...missionFields } = createMissionInputSchema;
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/** No Ruflo package dependency: the host agent coordinates the two MCP servers. */
export function registerWorkforceTools(
  server: McpServer,
  { client, config }: { client: AiworkpayClient; config: ServerConfig }
): void {
  server.registerTool('prepare_workforce_handoff', {
    title: 'Prepare a Ruflo task for human delegation',
    description: 'Read-only preparation of a human subtask from a Ruflo swarm. Returns create_mission arguments with a stable reference and a checkpoint template. Creates nothing and does not write Ruflo memory. Save the checkpoint in your own agent-scoped persistent memory.',
    inputSchema: { context: contextSchema, mission: z.object(missionFields).strict() },
    annotations: readOnly,
  }, ({ context, mission }) => runTool('prepare_workforce_handoff', async () => {
    assertSpendAllowed(mission, config);
    const digest = createHash('sha256').update(JSON.stringify([context.swarm_id, context.task_id, context.handoff_id])).digest('hex');
    const reference = `ruflo-${digest.slice(0, 48)}`;
    return ok({
      protocol: 'aiworkpay.workforce.v1',
      created: false,
      charged: false,
      context,
      create_mission_arguments: { ...mission, client_reference: reference, confirm: false },
      checkpoint: { context, client_reference: reference, mission_id: null, phase: 'prepared' },
      next_action: 'Save the checkpoint in agent-scoped persistent memory. Preview create_mission with these arguments; after reviewing, create with confirm=true. Save returned mission_id before continuing; give payment_url to the human owner. Reuse the reference and original arguments on retries.',
      authorization: 'confirm=true is not proof of human consent. Use a missions:read/missions:write key without missions:approve when human dashboard approval is required.',
    });
  }));

  server.registerTool('get_workforce_handoff', {
    title: 'Read the human subtask before resuming Ruflo',
    description: 'Read-only snapshot of an AIWorkPay mission for a Ruflo checkpoint. Distinguishes waiting, canceled, result needing review and completed. Does not resume or complete a Ruflo task, write memory, approve results or pay anyone. Context is supplied by the caller, not verified against the mission.',
    inputSchema: { context: contextSchema, mission_id: z.string().trim().min(1).max(100) },
    annotations: readOnly,
  }, ({ context, mission_id }) => runTool('get_workforce_handoff', async () => {
    const mission = await client.getMission(mission_id);
    const view = missionView(mission);
    const phase = view.status === 'canceled' ? 'canceled'
      : view.status === 'completed' ? 'completed'
      : view.status === 'delivered' ? 'awaiting_review'
      : view.status === 'awaiting_payment' ? 'awaiting_payment' : 'waiting_for_worker';
    return ok({
      protocol: 'aiworkpay.workforce.v1',
      context,
      context_source: 'caller_checkpoint_unverified',
      mission: view,
      phase,
      ready_to_resume: view.status === 'completed',
      poll_after_seconds: view.result_available || view.status === 'canceled' ? null : 300,
      result: view.result_available ? missionResultView(mission) : null,
      next_action: phase === 'awaiting_review'
        ? 'Verify note, data and proofs. Ask the human owner to approve in AIWorkPay or request changes. Do not mark the Ruflo task complete yet.'
        : phase === 'completed'
          ? 'Verify evidence and update the saved checkpoint, then resume the dependent Ruflo task. Mission completion does not prove payout settlement; check AIWorkPay separately.'
          : phase === 'canceled' ? 'Keep the dependent task blocked; ask the owner whether to abandon it or prepare a new handoff.'
            : 'Save the checkpoint and wait at least poll_after_seconds before reading again. Other independent Ruflo tasks may continue.',
    });
  }));
}
