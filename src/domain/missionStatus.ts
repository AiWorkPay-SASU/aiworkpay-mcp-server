import type { Mission, MissionStatus } from '../api/types.js';

/** Status vocabulary exposed to agents. */
export type AgentStatus =
  | 'awaiting_payment'
  | 'open'
  | 'assigned'
  | 'in_progress'
  | 'delivered'
  | 'completed'
  | 'canceled';

export const AGENT_STATUSES: readonly AgentStatus[] = [
  'awaiting_payment',
  'open',
  'assigned',
  'in_progress',
  'delivered',
  'completed',
  'canceled',
];

const TO_AGENT: Record<MissionStatus, AgentStatus> = {
  PAYMENT_PENDING: 'awaiting_payment',
  CREATED: 'awaiting_payment', // unused by the API, kept for completeness
  PUBLISHED: 'open',
  ASSIGNED: 'assigned',
  IN_PROGRESS: 'in_progress',
  DELIVERED: 'delivered',
  COMPLETED: 'completed',
  CANCELED: 'canceled',
};

const TO_API: Record<AgentStatus, MissionStatus> = {
  awaiting_payment: 'PAYMENT_PENDING',
  open: 'PUBLISHED',
  assigned: 'ASSIGNED',
  in_progress: 'IN_PROGRESS',
  delivered: 'DELIVERED',
  completed: 'COMPLETED',
  canceled: 'CANCELED',
};

export function toAgentStatus(status: MissionStatus): AgentStatus {
  return TO_AGENT[status];
}

export function toApiStatus(status: AgentStatus): MissionStatus {
  return TO_API[status];
}

export function isResultAvailable(status: AgentStatus): boolean {
  return status === 'delivered' || status === 'completed';
}

function nextAction(mission: Mission, status: AgentStatus, pastDeadline: boolean): string {
  switch (status) {
    case 'awaiting_payment':
      return mission.checkoutUrl
        ? 'The mission is not published until it is paid. Give payment_url to your human owner; check again later.'
        : 'The mission is not published until it is paid; check again later.';
    case 'open':
      return pastDeadline
        ? 'The deadline has passed and no Payworker took the mission. Contact the AIWorkPay team to cancel it.'
        : 'Published, waiting for a Payworker to accept it. Check again later.';
    case 'assigned':
    case 'in_progress':
      return 'A Payworker is working on it. Check again later.';
    case 'delivered':
      return 'The result is available: call get_mission_result. It is paid out to the Payworker once AIWorkPay validates it.';
    case 'completed':
      return 'Validated and paid. Call get_mission_result to read the result.';
    case 'canceled':
      return 'Canceled; nothing more will happen. Any payment made was refunded.';
  }
}

/** Compact mission view for agents. */
export function missionView(mission: Mission, now = new Date()) {
  const status = toAgentStatus(mission.status);
  const pastDeadline = new Date(mission.deadline).getTime() < now.getTime();
  const finished = status === 'completed' || status === 'canceled';

  return {
    mission_id: mission.id,
    title: mission.title,
    status,
    budget: Number(mission.budget),
    currency: mission.currency,
    priority: mission.priority.toLowerCase(),
    deadline: mission.deadline,
    is_past_deadline: pastDeadline && !finished,
    assigned: Boolean(mission.assignedToUserId),
    result_available: isResultAvailable(status),
    delivered_at: mission.deliveredAt ?? null,
    payment_url: status === 'awaiting_payment' ? (mission.checkoutUrl ?? null) : null,
    payment_url_expires_at: status === 'awaiting_payment' ? (mission.checkoutExpiresAt ?? null) : null,
    created_at: mission.createdAt,
    updated_at: mission.updatedAt,
    next_action: nextAction(mission, status, pastDeadline),
  };
}
