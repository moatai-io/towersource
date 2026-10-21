import { z } from 'zod';
import { clientConfig, clientEnabled, type ClientConfig } from './config.js';
import { assertNoSecrets, digest, FeedbackError, keySchema, payloadDigest, receiptSchema, submissionSchema, type Receipt, type Submission } from './contract.js';

export { clientEnabled };
export interface ReporterContext { sessionId: string; userId: number; username?: string | null; projectId?: string | null }
export interface SubmitArgs { title: string; body: string; repo?: string; allowPublicRepo?: boolean; idempotencyKey?: string }
export function closureSubmission(ctx: ReporterContext, args: SubmitArgs): Submission {
  if (args.repo || args.allowPublicRepo) throw new FeedbackError('feedback_repository_override_not_allowed', 400);
  const payload = submissionSchema.parse({ title: args.title, body: args.body,
    reporter: { userId: ctx.userId, username: ctx.username ?? null, sessionId: ctx.sessionId, projectId: ctx.projectId ?? null },
  });
  assertNoSecrets(payload);
  return payload;
}
export function defaultSubmissionKey(payload: Submission): string {
  // Same session + same content is one submission, including after network timeout/restart.
  return digest(`tower-feedback:v1:${payloadDigest(payload)}`);
}
export class FeedbackClient {
  constructor(private readonly config: ClientConfig, private readonly fetcher: typeof fetch = fetch) {}
  private async request(path: string, init: RequestInit): Promise<Receipt> {
    try {
      const response = await this.fetcher(`${this.config.origin}/api/feedback-intake${path}`, {
        ...init, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { ...init.headers, Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        // Never surface raw HTTP bodies: central proxies may include credential/config context.
        throw new FeedbackError(response.status === 409 ? 'feedback_idempotency_conflict'
          : response.status === 429 ? 'feedback_rate_limited' : `feedback_intake_http_${response.status}`);
      }
      const receipt = receiptSchema.parse(await response.json());
      if (receipt.issueUrl) {
        const url = new URL(receipt.issueUrl);
        if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash
          || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/.test(url.pathname)) throw new Error();
      }
      return receipt;
    } catch (error) {
      if (error instanceof FeedbackError) throw error;
      throw new FeedbackError('feedback_acceptance_unknown_retry_same_request');
    }
  }
  async submit(ctx: ReporterContext, args: SubmitArgs): Promise<Receipt> {
    const payload = closureSubmission(ctx, args);
    const key = keySchema.parse(args.idempotencyKey ?? defaultSubmissionKey(payload));
    return this.request('/', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload) });
  }
  async status(ctx: ReporterContext, receiptId: string): Promise<Receipt> {
    const id = z.string().uuid().parse(receiptId);
    return this.request(`/${id}`, { method: 'GET', headers: { 'X-Feedback-Reporter-Id': String(ctx.userId) } });
  }
}
export function feedbackClient(): FeedbackClient { return new FeedbackClient(clientConfig()); }
export function formatReceipt(receipt: Receipt): string {
  const messages: Record<Receipt['status'], string> = {
    accepted: '피드백이 중앙에 접수되었습니다. GitHub 전송은 아직 완료되지 않았습니다.',
    delivering: '피드백이 접수되었으며 GitHub로 전송 중입니다.',
    delivered: '피드백이 접수되었으며 GitHub 전송이 완료되었습니다.',
    needs_review: '피드백은 보관되어 있습니다. 전송 결과가 불확실하여 중복 생성 방지를 위해 운영자 확인이 필요합니다.',
    failed: '피드백은 보관되어 있지만 GitHub 전송에 실패했습니다. 운영자 확인이 필요합니다.',
  };
  return `${messages[receipt.status]}\nReceipt: ${receipt.id}\nStatus: ${receipt.status}`
    + (receipt.issueUrl ? `\nIssue: ${receipt.issueUrl}` : '');
}
