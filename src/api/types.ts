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
  createdAt: string;
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

export interface CreateMissionResponse {
  mission: Mission;
  payment: CheckoutPayment | { mode: 'payment_intent' } | null;
}
