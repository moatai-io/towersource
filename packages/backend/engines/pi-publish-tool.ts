import { deployErrorResponse } from '../services/deploy/deploy-error.js';
import {publishedSiteUrl} from '../services/publishing/published-url.js';
/**
 * pi-publish-tool.ts — first-class AI publishing bridge.
 *
 * Owns: publish_site Pi tool that lets AI publish project static outputs without
 * exposing user/API tokens or writing workspace/published directly.
 * Public API: createPublishSiteTool(ctx).
 */
import path from 'path';
import { assertSessionAllowsSharedArtifactWrite } from '../services/session/session-artifact-privacy.js';
import { promises as fs } from 'fs';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { config } from '../config.js';
import { deploy, type Access } from '../services/deploy/deploy-engine.js';
import { isPathAccessible, isPathWritableByRole } from '../services/pm/project-access.js';

export interface PublishToolContext {
  sessionId?: string;
  userId?: number;
  userRole?: string;
  cwd: string;
}

const PublishSiteParams = Type.Object({
  name: Type.String({
    minLength: 1,
    maxLength: 80,
    description: 'Lowercase site name/slug base, e.g. monthly-report. Use lowercase letters, numbers, and hyphens.',
  }),
  sourceDir: Type.String({
    minLength: 1,
    maxLength: 1000,
    description: 'Project-local static output directory containing index.html. Relative paths resolve from the current session cwd.',
  }),
  access: Type.Optional(Type.Union([
    Type.Literal('unlisted'),
    Type.Literal('public'),
  ], {
    description: 'Visibility for the published link. Default unlisted. public should only be used when the user explicitly asks for a public/SEO/short URL.',
  })),
  description: Type.Optional(Type.String({
    maxLength: 300,
    description: 'Short human-readable description shown in Publishing Hub.',
  })),
});

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError, details: undefined };
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-');
}

function resolveSourceDir(input: string, cwd: string): string {
  const expanded = input.startsWith('~/')
    ? path.join(process.env.HOME || '', input.slice(2))
    : input;
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded));
}

function siteUrlForSlug(slug: string): string | null {
  return publishedSiteUrl(slug, config.publicUrl, config.publishingBaseUrl) ?? null;
}

async function verifyUrl(url: string | null): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!url) return { ok: false, error: 'PUBLIC_URL is not configured' };
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000) });
    // Consume only a tiny prefix so sockets close without loading large pages.
    await res.body?.cancel().catch(() => {});
    return { ok: res.status >= 200 && res.status < 400, status: res.status };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export function createPublishSiteTool(ctx: PublishToolContext): ToolDefinition {
  return {
    name: 'publish_site',
    label: 'Publish Static Site',
    description: [
      'Publish a project-local static HTML/CSS/JS output directory to Tower Publishing Hub and return the live URL.',
      'Use this instead of curl /api/deploy, TOWER_API_TOKEN, localhost servers, sandbox static viewers, or direct workspace/published/sites symlinks.',
      'The current user/session identity is closed over by Tower; the AI cannot forge userId or role.',
    ].join(' '),
    promptSnippet: 'Publish static outputs with publish_site after creating index.html/dist. Do not call /api/deploy via curl or ask for TOWER_API_TOKEN.',
    promptGuidelines: [
      'Use publish_site when the user asks to publish/share a static HTML page, dashboard, report, calculator, or generated site.',
      'First create or build the files under the current project, then pass the directory containing index.html as sourceDir.',
      'Default access is unlisted. Use public only when the user explicitly requests public/SEO/short URL.',
      'Only announce the returned URL if publish_site succeeds. If verification fails, report the concrete failure instead of inventing a URL.',
    ],
    parameters: PublishSiteParams,
    async execute(_toolCallId: string, params: {
      name: string;
      sourceDir: string;
      access?: 'unlisted' | 'public';
      description?: string;
    }) {
      try {
        await assertSessionAllowsSharedArtifactWrite(ctx.sessionId);
        if (!ctx.userId) return textResult('publish_site failed: authenticated user context is missing.', true);
        if (ctx.userRole === 'viewer' || ctx.userRole === 'guest') {
          return textResult('publish_site failed: publishing requires project member or above.', true);
        }

        const name = normalizeName(params.name);
        if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
          return textResult('publish_site failed: name must contain lowercase letters, numbers, and hyphens.', true);
        }

        const sourceDir = resolveSourceDir(params.sourceDir, ctx.cwd);
        if (!await isPathAccessible(sourceDir, ctx.userId, ctx.userRole || 'member')) {
          return textResult(`publish_site failed: sourceDir is not accessible: ${sourceDir}`, true);
        }
        if (!await isPathWritableByRole(sourceDir, ctx.userId, ctx.userRole || 'member')) {
          return textResult(`publish_site failed: sourceDir must be inside a writable project folder: ${sourceDir}`, true);
        }

        const st = await fs.stat(sourceDir).catch(() => null);
        if (!st?.isDirectory()) return textResult(`publish_site failed: sourceDir is not a directory: ${sourceDir}`, true);
        const indexPath = path.join(sourceDir, 'index.html');
        const hasIndex = await fs.stat(indexPath).then(s => s.isFile()).catch(() => false);
        if (!hasIndex) {
          return textResult(`publish_site failed: sourceDir must contain index.html: ${indexPath}`, true);
        }

        const access = (params.access || 'unlisted') as Access;
        if (access !== 'unlisted' && access !== 'public') {
          return textResult('publish_site failed: access must be unlisted or public.', true);
        }

        const result = await deploy({
          name,
          sourceDir,
          target: 'local',
          access,
          description: params.description,
        });
        if (!result.success) {
          return textResult(`publish_site failed: ${result.error || 'deploy failed'}`, true);
        }

        const slug = result.slug || name;
        const url = result.url || siteUrlForSlug(slug);
        const verification = await verifyUrl(url);
        const lines = [
          verification.ok ? 'publish_site succeeded.' : 'publish_site published; URL verification failed. Do not automatically republish.',
          `name: ${name}`,
          `slug: ${slug}`,
          `access: ${access}`,
          `sourceDir: ${sourceDir}`,
          `url: ${url || '(PUBLIC_URL not configured)'}`,
          `verification: ${verification.ok ? 'ok' : 'failed'}${verification.status ? ` (HTTP ${verification.status})` : ''}${verification.error ? ` — ${verification.error}` : ''}`,
        ];
        return textResult(lines.join('\n'), !verification.ok);
      } catch (err: any) {
        const diagnostic = deployErrorResponse(err);
        return textResult(`publish_site failed: ${JSON.stringify(diagnostic)}`, true);
      }
    },
  } as ToolDefinition;
}
