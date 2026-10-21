/**
 * issue-server.ts — in-process MCP bridge for Tower GitHub issue filing.
 *
 * Owns: VM service-credential based issue creation and follow-up comments for Tower feedback/bug capture.
 * Public API: createIssueMcpServer(ctx).
 *
 * Design: the AI/user should never need a GH_TOKEN in Runtime Box. This server
 * uses the backend VM's GitHub service credential (`gh`) and closure-bound Tower
 * session context to file private GitHub issues safely.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { clientEnabled, feedbackClient, formatReceipt } from '../services/feedback-intake/client.js';
import { safeCode } from '../services/feedback-intake/contract.js';

const execFileAsync = promisify(execFile);

export interface IssueMcpContext {
  sessionId: string;
  userId: number;
  username?: string | null;
  userRole?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  cwd?: string | null;
}

const FORCED_LABEL = 'from:tower-skill';

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'OpenAI API key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'GitHub token', re: /gh[pous]_[A-Za-z0-9]{20,}/ },
  { name: 'Slack token', re: /xox[bpoa]-[A-Za-z0-9-]{10,}/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY/ },
];

const FILE_ISSUE_DESCRIPTION = [
  'File a GitHub issue using Tower VM service credentials, not user/runtime tokens.',
  '',
  'Use when the user asks to register/report/file an issue, bug, improvement, or feedback for the Tower team.',
  'Do not ask the user for GH_TOKEN or API tokens. The backend VM service credential is used automatically.',
  'The server-configured target repository must be private/internal.',
  'The tool scans the body for common secret patterns and refuses to file if one is found.',
].join('\n');

const COMMENT_ISSUE_DESCRIPTION = [
  'Add a follow-up comment to an existing GitHub issue using Tower VM service credentials.',
  '',
  'Use when the user asks to update an already-filed issue with verification results, extra context, or follow-up notes.',
  'Do not ask the user for GH_TOKEN or API tokens. The backend VM service credential is used automatically.',
  'The target repo must be private/internal unless allowPublicRepo is explicitly true.',
  'The tool scans the comment body for common secret patterns and refuses to comment if one is found.',
].join('\n');

const GET_ISSUE_DESCRIPTION = [
  'Read the current status and metadata for an existing GitHub issue using Tower VM service credentials.',
  '',
  'Use when the user asks whether an issue is open, closed, resolved, updated, assigned, or has follow-up comments.',
  'Do not ask the user for GH_TOKEN or API tokens. The backend VM service credential is used automatically.',
  'The target repo must be private/internal unless allowPublicRepo is explicitly true.',
  'Returns structured issue metadata and a small recent-comment summary, not raw secrets or credentials.',
].join('\n');

function cleanTitle(raw: string): string {
  return raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function serviceRepo(): string {
  const repo = process.env.GITHUB_ISSUE_REPO?.trim();
  if (!repo) {
    throw new Error('GITHUB_ISSUE_REPO is not configured. Ask an operator to set the organization-owned issue repository.');
  }
  return repo;
}

async function gh(args: string[], opts?: { input?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync('gh', args, {
    timeout: opts?.timeoutMs ?? 20_000,
    maxBuffer: 1024 * 1024,
    input: opts?.input,
    env: {
      ...process.env,
      // gh CLI should never prompt from the backend process.
      GIT_TERMINAL_PROMPT: '0',
      GH_PROMPT_DISABLED: '1',
    },
  } as any);
  return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

async function ensurePrivateRepo(repo: string, allowPublicRepo: boolean): Promise<void> {
  if (allowPublicRepo) return;
  const { stdout } = await gh(['api', `/repos/${repo}`, '--jq', '.visibility'], { timeoutMs: 10_000 });
  const visibility = stdout.trim().toLowerCase();
  if (visibility !== 'private' && visibility !== 'internal') {
    throw new Error(`target repo ${repo} is ${visibility || 'unknown'}; refusing to file session context to a non-private repo`);
  }
}

function findSecretHits(text: string): string[] {
  return SECRET_PATTERNS.filter(({ re }) => re.test(text)).map(({ name }) => name);
}

function issueUrl(repo: string, issueNumber: number): string {
  return `https://github.com/${repo}/issues/${issueNumber}`;
}

function truncateText(text: string | undefined | null, maxChars = 500): string {
  const value = String(text || '').trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function summarizeIssue(raw: string, includeComments: boolean) {
  const parsed = JSON.parse(raw);
  const comments = includeComments && Array.isArray(parsed.comments)
    ? parsed.comments.slice(-5).map((comment: any) => ({
      author: comment?.author?.login || comment?.author?.name || null,
      createdAt: comment?.createdAt || null,
      updatedAt: comment?.updatedAt || null,
      bodyPreview: truncateText(comment?.body, 700),
    }))
    : [];

  return {
    number: parsed.number,
    title: parsed.title,
    state: parsed.state,
    stateReason: parsed.stateReason || null,
    closed: Boolean(parsed.closed),
    createdAt: parsed.createdAt || null,
    updatedAt: parsed.updatedAt || null,
    closedAt: parsed.closedAt || null,
    url: parsed.url,
    author: parsed.author?.login || parsed.author?.name || null,
    assignees: Array.isArray(parsed.assignees) ? parsed.assignees.map((a: any) => a?.login || a?.name).filter(Boolean) : [],
    labels: Array.isArray(parsed.labels) ? parsed.labels.map((label: any) => label?.name).filter(Boolean) : [],
    closedByPullRequestsReferences: Array.isArray(parsed.closedByPullRequestsReferences)
      ? parsed.closedByPullRequestsReferences.map((pr: any) => ({
        number: pr?.number,
        title: pr?.title,
        url: pr?.url,
        state: pr?.state,
        mergedAt: pr?.mergedAt || null,
      }))
      : [],
    bodyPreview: truncateText(parsed.body, 1200),
    comments,
  };
}

function buildContextFooter(ctx: IssueMcpContext): string {
  return [
    '',
    '---',
    '_Filed via Tower issue tool._',
    '',
    `- VM: \`${os.hostname()}\``,
    `- Session: \`${ctx.sessionId}\``,
    `- User: \`${ctx.username || `user:${ctx.userId}`}\`${ctx.userRole ? ` (${ctx.userRole})` : ''}`,
    `- Project: \`${ctx.projectName || ctx.projectId || '(none)'}\``,
    `- CWD: \`${ctx.cwd || '(none)'}\``,
    `- Time: \`${new Date().toISOString()}\``,
  ].join('\n');
}

export function userSafeErrorMessage(err: any): string {
  const raw = String(err?.stderr || err?.message || err || 'unknown error').trim();

  if (/not logged into any GitHub hosts|gh auth login|GH_TOKEN|GITHUB_TOKEN|authentication required|requires authentication|HTTP 401|Bad credentials/i.test(raw)) {
    return 'Tower issue service credential is not configured on this VM. Ask an operator to connect the VM-level GitHub issue credential.';
  }

  // GitHub deliberately returns 404 for private repositories when the caller
  // cannot see them. Treat repository-not-found and HTTP 404 alike so users get
  // an actionable configuration/permission diagnosis instead of raw CLI output.
  if (/HTTP 404|Could not resolve to a Repository|repository not found|Not Found \(HTTP 404\)/i.test(raw)) {
    return 'Tower issue repository was not found or the VM service credential cannot access it. Ask an operator to verify GITHUB_ISSUE_REPO and private-repository Issues permission.';
  }

  if (/HTTP 403|Resource not accessible by integration|must have.*issues.*permission|permission.*issues/i.test(raw)) {
    return 'Tower issue service can reach GitHub but lacks permission to use this repository. Ask an operator to grant private-repository Issues write access.';
  }

  if (/could not resolve host|network is unreachable|connection timed out|TLS|SSL|ECONNRESET|ENOTFOUND/i.test(raw)) {
    return 'Tower issue service could not reach GitHub from this VM. Ask an operator to check network access.';
  }

  return raw || 'unknown error';
}

export function createIssueMcpServer(ctx: IssueMcpContext) {
  return createSdkMcpServer({
    name: 'issue',
    version: '0.1.0',
    tools: [
      tool(
        'file_issue',
        clientEnabled()
          ? 'Submit feedback to the central Tower inbox using self-hosted instance authentication and closure-bound reporter identity. Accepted is not yet delivered to GitHub. Repository, labels, and idempotency are server-managed. Do not request a GitHub token.'
          : FILE_ISSUE_DESCRIPTION,
        {
          title: z.string().min(1).max(200).describe('GitHub issue title.'),
          body: z.string().min(1).max(30000).describe('Issue body in markdown. Do not include secrets.'),
        },
        async (args) => {
          if (clientEnabled()) {
            try {
              const receipt = await feedbackClient().submit(ctx, args);
              return { content: [{ type: 'text' as const, text: formatReceipt(receipt) }] };
            } catch (error) {
              return { content: [{ type: 'text' as const, text: `file_issue failed: ${safeCode(error)}` }], isError: true };
            }
          }
          try {
            const title = cleanTitle(args.title);
            if (!title) {
              return { content: [{ type: 'text' as const, text: 'file_issue failed: title is empty after trimming.' }], isError: true };
            }

            const repo = serviceRepo();
            const labels = [FORCED_LABEL];
            const body = `${args.body.trim()}${buildContextFooter(ctx)}`;
            const secretHits = findSecretHits(`${title}\n${body}`);
            if (secretHits.length > 0) {
              return {
                content: [{ type: 'text' as const, text: `file_issue refused: body appears to contain secrets (${secretHits.join(', ')}). Redact first.` }],
                isError: true,
              };
            }

            await gh(['auth', 'status'], { timeoutMs: 10_000 });
            await ensurePrivateRepo(repo, false);

            const baseArgs = ['issue', 'create', '--repo', repo, '--title', title, '--body', body];
            const withLabels = labels.flatMap((label) => ['--label', label]);
            let url = '';
            try {
              const result = await gh([...baseArgs, ...withLabels], { timeoutMs: 30_000 });
              url = result.stdout.trim();
            } catch (err: any) {
              const stderr = String(err?.stderr || err?.message || '');
              if (!/could not add label|label.*not found|not found.*label/i.test(stderr)) throw err;
              const result = await gh(baseArgs, { timeoutMs: 30_000 });
              url = result.stdout.trim();
            }

            return {
              content: [{
                type: 'text' as const,
                text: `Filed issue: ${url}\nRepo: ${repo}\nTitle: ${title}`,
              }],
            };
          } catch (err: any) {
            console.warn('[issue-mcp] file_issue failed:', String(err?.stderr || err?.message || err || 'unknown error').trim());
            return {
              content: [{ type: 'text' as const, text: `file_issue failed: ${userSafeErrorMessage(err)}` }],
              isError: true,
            };
          }
        },
      ),
      ...(clientEnabled() ? [tool(
        'get_feedback_status',
        'Read a central feedback receipt for the closure-bound reporter. Accepted is not the same as delivered to GitHub.',
        { receipt_id: z.string().uuid().describe('Receipt ID returned by file_issue.') },
        async (args) => {
          try {
            const receipt = await feedbackClient().status(ctx, args.receipt_id);
            return { content: [{ type: 'text' as const, text: formatReceipt(receipt) }] };
          } catch (error) {
            return { content: [{ type: 'text' as const, text: `get_feedback_status failed: ${safeCode(error)}` }], isError: true };
          }
        },
      )] : []),
      tool(
        'get_issue',
        clientEnabled() ? 'Unavailable in central feedback mode. Use get_feedback_status with the receipt ID instead.' : GET_ISSUE_DESCRIPTION,
        {
          issue_number: z.number().int().positive().describe('GitHub issue number to read.'),
          repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).optional().describe('Optional target repo override. Defaults to the server-configured GITHUB_ISSUE_REPO.'),
          includeComments: z.boolean().optional().describe('Include up to 5 recent comment previews. Default true.'),
          allowPublicRepo: z.boolean().optional().describe('Allow reading from a public repo. Default false.'),
        },
        async (args) => {
          if (clientEnabled()) return {
            content: [{ type: 'text' as const, text: 'Central feedback mode: use get_feedback_status with the receipt ID. Direct GitHub readback is disabled.' }], isError: true,
          };
          try {
            const repo = args.repo || serviceRepo();
            await gh(['auth', 'status'], { timeoutMs: 10_000 });
            await ensurePrivateRepo(repo, args.allowPublicRepo === true);

            const fields = [
              'assignees',
              'author',
              'body',
              'closed',
              'closedAt',
              'closedByPullRequestsReferences',
              'comments',
              'createdAt',
              'labels',
              'number',
              'state',
              'stateReason',
              'title',
              'updatedAt',
              'url',
            ].join(',');
            const result = await gh(['issue', 'view', String(args.issue_number), '--repo', repo, '--json', fields], { timeoutMs: 30_000 });
            const summary = summarizeIssue(result.stdout, args.includeComments !== false);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ repo, issue: summary }, null, 2),
              }],
            };
          } catch (err: any) {
            console.warn('[issue-mcp] get_issue failed:', String(err?.stderr || err?.message || err || 'unknown error').trim());
            return {
              content: [{ type: 'text' as const, text: `get_issue failed: ${userSafeErrorMessage(err)}` }],
              isError: true,
            };
          }
        },
      ),
      tool(
        'comment_issue',
        clientEnabled() ? 'Unavailable in central feedback mode. Direct GitHub comments are disabled for customer isolation.' : COMMENT_ISSUE_DESCRIPTION,
        {
          issue_number: z.number().int().positive().describe('GitHub issue number to comment on.'),
          body: z.string().min(1).max(30000).describe('Comment body in markdown. Do not include secrets.'),
          repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).optional().describe('Optional target repo override. Defaults to the server-configured GITHUB_ISSUE_REPO.'),
          allowPublicRepo: z.boolean().optional().describe('Allow commenting on a public repo. Default false.'),
        },
        async (args) => {
          if (clientEnabled()) return {
            content: [{ type: 'text' as const, text: 'Central feedback mode: direct GitHub comments are disabled to preserve customer isolation.' }], isError: true,
          };
          try {
            const repo = args.repo || serviceRepo();
            const body = `${args.body.trim()}${buildContextFooter(ctx)}`;
            const secretHits = findSecretHits(body);
            if (secretHits.length > 0) {
              return {
                content: [{ type: 'text' as const, text: `comment_issue refused: body appears to contain secrets (${secretHits.join(', ')}). Redact first.` }],
                isError: true,
              };
            }

            await gh(['auth', 'status'], { timeoutMs: 10_000 });
            await ensurePrivateRepo(repo, args.allowPublicRepo === true);

            await gh(['issue', 'comment', String(args.issue_number), '--repo', repo, '--body', body], { timeoutMs: 30_000 });
            return {
              content: [{
                type: 'text' as const,
                text: `Commented on issue: ${issueUrl(repo, args.issue_number)}\nRepo: ${repo}`,
              }],
            };
          } catch (err: any) {
            console.warn('[issue-mcp] comment_issue failed:', String(err?.stderr || err?.message || err || 'unknown error').trim());
            return {
              content: [{ type: 'text' as const, text: `comment_issue failed: ${userSafeErrorMessage(err)}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
