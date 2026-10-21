import { createSign } from 'node:crypto';
import type { GitHubAppConfig } from './config.js';
import { assertNoSecrets, FeedbackError, submissionSchema, type Delivery } from './contract.js';

export class DeliveryFailure extends FeedbackError {
  constructor(code: string, public readonly disposition: 'retry' | 'review' | 'failed') { super(code); }
}
export function appJwt(config: GitHubAppConfig, now = Date.now()): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const issued = Math.floor(now / 1000);
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: issued - 60, exp: issued + 540, iss: config.appId })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(config.privateKey, 'base64url')}`;
}
const inline = (value: unknown) => String(value).replace(/[\r\n`<>]/g, ' ').replace(/@/g, '＠');
export function githubIssue(delivery: Delivery): { title: string; body: string; labels: string[] } {
  const payload = submissionSchema.parse(delivery.payload);
  assertNoSecrets(payload);
  const { reporter } = payload;
  return {
    title: `[${delivery.tenant.titlePrefix}] ${payload.title}`.slice(0, 256),
    body: `${payload.body}\n\n---\n_Filed via Tower central feedback._\n\n`
      + `- Customer: \`${inline(delivery.tenant.id)}\`\n`
      + `- Reporter: \`${inline(reporter.username ?? `user:${reporter.userId}`)}\` (user ${reporter.userId})\n`
      + `- Session: \`${inline(reporter.sessionId)}\`\n`
      + (reporter.projectId ? `- Project: \`${inline(reporter.projectId)}\`\n` : '')
      + `- Receipt: \`${delivery.id}\`\n<!-- tower-feedback:${delivery.id} -->`,
    labels: ['from:tower-feedback', delivery.tenant.label],
  };
}

export class GitHubAppDelivery {
  constructor(private readonly config: GitHubAppConfig, private readonly fetcher: typeof fetch = fetch) {}
  private async request(path: string, token: string, body?: object, create = false): Promise<any> {
    try {
      const response = await this.fetcher(`https://api.github.com${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        // Explicit validation/auth/rate rejection cannot have created an issue.
        if (create && ![401, 403, 404, 422, 429].includes(response.status)) throw new DeliveryFailure('github_create_uncertain', 'review');
        const disposition = response.status === 429 || response.status >= 500 ? 'retry' : 'failed';
        throw new DeliveryFailure(`github_http_${response.status}`, disposition);
      }
      if (create && response.status !== 201) throw new DeliveryFailure('github_create_uncertain', 'review');
      return await response.json();
    } catch (error) {
      if (error instanceof DeliveryFailure) throw error;
      throw new DeliveryFailure(create ? 'github_create_uncertain' : 'github_preflight_unavailable', create ? 'review' : 'retry');
    }
  }
  async send(delivery: Delivery): Promise<{ issueNumber: number; issueUrl: string }> {
    const body = githubIssue(delivery);
    // Do not cache or persist tokens. Restrict every minted token to one repository.
    const installation = await this.request(`/app/installations/${this.config.installationId}/access_tokens`, appJwt(this.config), {
      repository_ids: [this.config.repositoryId], permissions: { issues: 'write', metadata: 'read' },
    });
    if (typeof installation.token !== 'string' || !installation.token
      || installation.permissions?.issues !== 'write'
      || Object.keys(installation.permissions ?? {}).some(key => !['issues', 'metadata'].includes(key))) {
      throw new DeliveryFailure('github_token_scope_invalid', 'failed');
    }
    const repo = await this.request(`/repos/${this.config.repository}`, installation.token);
    if (repo.private !== true || repo.visibility !== 'private' || repo.id !== this.config.repositoryId
      || String(repo.full_name).toLowerCase() !== this.config.repository.toLowerCase()) {
      throw new DeliveryFailure('github_repository_not_private_or_mismatch', 'failed');
    }
    const created = await this.request(`/repos/${this.config.repository}/issues`, installation.token, body, true);
    if (!Number.isSafeInteger(created.number) || created.number < 1) throw new DeliveryFailure('github_create_uncertain', 'review');
    // Construct from centrally configured repo, never trust a provider-supplied arbitrary URL.
    return { issueNumber: created.number, issueUrl: `https://github.com/${this.config.repository}/issues/${created.number}` };
  }
}
