import { createHash } from 'node:crypto';
import { z } from 'zod';

export const reporterSchema = z.object({
  userId: z.number().int().positive().safe(),
  username: z.string().trim().min(1).max(120).nullable(),
  sessionId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/),
  projectId: z.string().max(100).regex(/^[A-Za-z0-9_-]+$/).nullable(),
}).strict();

export const submissionSchema = z.object({
  title: z.string().trim().min(1).max(200).transform(s => s.replace(/[\r\n\t]+/g, ' ')),
  body: z.string().trim().min(1).max(30000),
  reporter: reporterSchema,
}).strict();

export const keySchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const tokenSchema = z.string().min(43).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const receiptSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['accepted', 'delivering', 'delivered', 'needs_review', 'failed']),
  issueNumber: z.number().int().positive().optional(),
  issueUrl: z.string().url().optional(),
}).strict().refine(value => value.status === 'delivered'
  ? value.issueNumber !== undefined && value.issueUrl !== undefined
  : value.issueNumber === undefined && value.issueUrl === undefined, 'Receipt delivery fields must match status');
export type Submission = z.infer<typeof submissionSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type Status = Receipt['status'];
export interface Tenant { id: string; titlePrefix: string; label: string }
export interface Delivery {
  id: string;
  tenant: Tenant;
  payload: Submission;
  attempts: number;
  claimId: string;
}
export interface IntakeStore {
  authenticate(tokenHash: string): Promise<Tenant | null>;
  accept(tenant: Tenant, key: string, payload: Submission): Promise<Receipt>;
  status(tenantId: string, id: string, userId: number): Promise<Receipt | null>;
  claim(): Promise<Delivery | null>;
  settle(delivery: Delivery, outcome: {
    status: 'accepted' | 'delivered' | 'needs_review' | 'failed';
    code?: string; issueNumber?: number; issueUrl?: string;
  }): Promise<void>;
}

export class FeedbackError extends Error {
  constructor(public readonly code: string, public readonly httpStatus = 503) { super(code); }
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function tokenDigest(value: string): string { return digest(`tower-feedback-token:v1:${value}`); }
export function payloadDigest(payload: Submission): string {
  // Reparse ensures deterministic field order, stripping no fields (schema is strict).
  return digest(JSON.stringify(submissionSchema.parse(payload)));
}
const secretPatterns = [
  /sk-[A-Za-z0-9_-]{20,}/, /gh[pousr]_[A-Za-z0-9_.-]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[bpoa]-[A-Za-z0-9-]{10,}/, /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{35}/, /-----BEGIN [A-Z ]*PRIVATE KEY/,
];
export function assertNoSecrets(payload: Submission): void {
  if (secretPatterns.some(re => re.test(JSON.stringify(payload)))) throw new FeedbackError('feedback_contains_secret', 422);
}
export function safeCode(error: unknown): string {
  return error instanceof FeedbackError ? error.code : 'feedback_unavailable';
}
