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
