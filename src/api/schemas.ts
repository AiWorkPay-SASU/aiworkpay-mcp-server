import { z } from 'zod';
const amount = z.union([z.number().finite(), z.string().regex(/^\d+(\.\d+)?$/)]);
const attachment = z.object({ id: z.string(), url: z.string(), filename: z.string(), mimeType: z.string().nullable(), size: z.number().nullable(), kind: z.enum(['BRIEF', 'PROOF']), source: z.enum(['upload', 'link']).optional(), scanStatus: z.enum(['CLEAN', 'NOT_SCANNED']).nullish(), createdAt: z.string() }).passthrough();
export const missionSchema = z.object({
  id: z.string().min(1), title: z.string(), description: z.string(), budget: amount,
  currency: z.string(), deadline: z.string(), priority: z.enum(['LOW','MEDIUM','HIGH']),
  status: z.enum(['PAYMENT_PENDING','CREATED','PUBLISHED','ASSIGNED','IN_PROGRESS','DELIVERED','COMPLETED','CANCELED']),
  createdAt: z.string(), updatedAt: z.string(), attachments: z.array(attachment).optional(),
}).passthrough();
export const createSchema = z.object({mission: missionSchema, payment: z.union([
  z.object({mode: z.literal('checkout'), checkoutSessionId: z.string(), url: z.string().nullable(), expiresAt: z.string().nullable()}),
  z.object({mode: z.literal('payment_intent')}).passthrough(), z.null()
])});
export const cancelSchema = z.object({mission: missionSchema, payment: z.enum(['checkout_closed','refunded','payment_canceled','nothing_to_release','already_canceled'])});
export const approveSchema = z.object({mission: missionSchema, alreadyApproved: z.boolean(), commission: z.object({payworkerAmount: z.number().finite(), platformFeeAmount: z.number().finite(), transferStatus: z.enum(['PENDING','SUCCEEDED'])}).optional()});
export const changesSchema = z.object({mission: missionSchema, revisionsLeft: z.number().int().nonnegative()});
const missionStatus = z.enum(['PAYMENT_PENDING','CREATED','PUBLISHED','ASSIGNED','IN_PROGRESS','DELIVERED','COMPLETED','CANCELED']);
const money = z.number().finite();
export const accountSchema = z.object({
  key: z.object({ id: z.string(), label: z.string(), prefix: z.string(), scopes: z.array(z.string()), active: z.boolean(), expiresAt: z.string().nullable(), lastUsedAt: z.string().nullable(), createdAt: z.string() }).passthrough(),
  limits: z.object({ maxMissionBudget: money.nullable(), monthlyBudget: money.nullable() }).passthrough(),
  usage: z.object({ monthStart: z.string(), committedThisMonth: money, remainingThisMonth: money.nullable(), totalPaid: money, totalRefunded: money, netPaid: money }).passthrough(),
  missions: z.object({ total: z.number().int().nonnegative(), byStatus: z.record(missionStatus, z.number().int().nonnegative()) }).passthrough(),
  webhook: z.object({ configured: z.boolean() }).passthrough(),
}).passthrough();
export const transactionsSchema = z.object({
  total: z.number().int().nonnegative(),
  transactions: z.array(z.object({ id: z.string(), type: z.literal('AGENT_PAYMENT'), status: z.enum(['PENDING','SUCCEEDED','FAILED']), amount: money, currency: z.string(), missionId: z.string().nullable(), missionStatus: missionStatus.nullable(), refunded: z.boolean(), createdAt: z.string() }).passthrough()),
});
