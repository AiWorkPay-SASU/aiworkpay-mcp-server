/**
 * Shapes returned by the AIWorkPay API (Aiworkpay-v2, `prisma/schema.prisma`).
 * Prisma serialises Decimal as a string and dates as ISO strings.
 */

export type MissionStatus =
  | 'PAYMENT_PENDING'
  | 'CREATED'
  | 'PUBLISHED'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'CANCELED';

export type Priority = 'LOW' | 'MEDIUM' | 'HIGH';

export interface MissionAttachment {
  id: string;
  url: string;
  filename: string;
  mimeType: string | null;
  size: number | null;
  /** BRIEF: provided with the mission. PROOF: delivered by the Payworker. */
  kind: 'BRIEF' | 'PROOF';
  /** upload: file stored by AIWorkPay (download it with get_proof_file). link: external URL. */
  source?: 'upload' | 'link';
  /** Antivirus result of an uploaded file: CLEAN, or NOT_SCANNED when scanning was off. */
  scanStatus?: 'CLEAN' | 'NOT_SCANNED' | null;
  createdAt: string;
}

export interface ProofFile {
  content: Buffer;
  contentType: string;
}

export interface Mission {
  id: string;
  title: string;
  description: string;
  budget: string | number;
  currency: string;
  deadline: string;
  priority: Priority;
  status: MissionStatus;
  checkoutUrl?: string | null;
  checkoutExpiresAt?: string | null;
  resultNote?: string | null;
  resultData?: unknown;
  deliveredAt?: string | null;
  revisionFeedback?: string | null;
  revisionCount?: number;
  /** Agent-facing views expose only this boolean; the internal assignee id is never sent to agents. */
  assigned?: boolean;
  /** Legacy: no longer returned by the backend to agents; kept optional for older servers. */
  assignedToUserId?: string | null;
  createdAt: string;
  updatedAt: string;
  attachments?: MissionAttachment[];
}

export interface CreateMissionRequest {
  title: string;
  description: string;
  budget: number;
  currency: string;
  deadline: string;
  priority: Priority;
  paymentMode: 'checkout';
}

export interface CheckoutPayment {
  mode: 'checkout';
  checkoutSessionId: string;
  url: string | null;
  expiresAt: string | null;
}

export type PaymentRelease = 'checkout_closed' | 'refunded' | 'payment_canceled' | 'nothing_to_release' | 'already_canceled';

export interface CancelMissionResponse {
  mission: Mission;
  payment: PaymentRelease;
}

export interface ApproveMissionResponse {
  mission: Mission;
  alreadyApproved: boolean;
  commission?: {
    payworkerAmount: number;
    platformFeeAmount: number;
    transferStatus: 'PENDING' | 'SUCCEEDED';
  };
}

export interface RequestChangesResponse {
  mission: Mission;
  revisionsLeft: number;
}

export interface CreateMissionResponse {
  mission: Mission;
  payment: CheckoutPayment | { mode: 'payment_intent' } | null;
}

/** GET /api/account: the calling key's own limits, budget used and missions. */
export interface AgentAccount {
  key: {
    id: string;
    label: string;
    prefix: string;
    scopes: string[];
    active: boolean;
    expiresAt: string | null;
    lastUsedAt: string | null;
    createdAt: string;
  };
  limits: { maxMissionBudget: number | null; monthlyBudget: number | null };
  usage: {
    monthStart: string;
    committedThisMonth: number;
    remainingThisMonth: number | null;
    totalPaid: number;
    totalRefunded: number;
    netPaid: number;
  };
  missions: { total: number; byStatus: Partial<Record<MissionStatus, number>> };
  webhook: { configured: boolean };
}

/** A payment booked on the calling key (GET /api/transactions). */
export interface AgentTransaction {
  id: string;
  type: 'AGENT_PAYMENT';
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  amount: number;
  currency: string;
  missionId: string | null;
  missionStatus: MissionStatus | null;
  /** The mission was canceled, so the payment was given back. */
  refunded: boolean;
  createdAt: string;
}

export interface TransactionsResponse {
  total: number;
  transactions: AgentTransaction[];
}
