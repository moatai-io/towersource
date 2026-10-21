/**
 * pi-present-file-tool.ts — file-backed artifact presentation intent.
 *
 * Owns: present_file, a lightweight Pi tool that lets the assistant ask Tower to
 * show an existing project/workspace file in the right-side Viewer Pane. The file remains a
 * normal Tower file; this is presentation intent, not a separate artifact store.
 * Public API: createPresentFileTool(ctx).
 */
import path from 'path';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { isPathAccessible } from '../services/pm/project-access.js';
import { projectWorkspaceEntryExists, resolveProjectWorkspaceFile } from '../services/project-environment/project-workspace-files.js';

export interface PresentFileToolContext {
  userId?: number;
  userRole?: string;
  cwd: string;
  projectId?: string;
  projectRoot?: string;
}

const PresentFileParams = Type.Object({
  path: Type.String({
    minLength: 1,
    maxLength: 2000,
    description: 'Existing project/workspace file path to present. Relative paths resolve from the current session cwd.',
  }),
  split: Type.Optional(Type.Union([
    Type.Literal('right'),
    Type.Literal('bottom'),
  ], {
    description: 'Deprecated location hint. Viewer Pane is right-side only; bottom is accepted for compatibility and normalized to right.',
  })),
  // Backward-compatible alias for early prototypes. Prefer omitting location in new calls.
  pane: Type.Optional(Type.Union([
    Type.Literal('right'),
    Type.Literal('bottom'),
  ], {
    description: 'Deprecated alias for split. Viewer Pane is right-side only.',
  })),
  label: Type.Optional(Type.String({
    maxLength: 160,
    description: 'Optional human-friendly label for the presented artifact. Defaults to the file basename.',
  })),
  focus: Type.Optional(Type.Boolean({
    description: 'Whether Tower should immediately focus/open the file in the right-side Viewer Pane. Default true.',
  })),
});

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError, details: undefined };
}

function resolveFilePath(input: string, cwd: string): string {
  const trimmed = input.trim();
  const expanded = trimmed.startsWith('~/')
    ? path.join(process.env.HOME || '', trimmed.slice(2))
    : trimmed;
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded));
}

function normalizeSplit(_split?: string, _pane?: string): 'right' {
  return 'right';
}

export function createPresentFileTool(ctx: PresentFileToolContext): ToolDefinition {
  return {
    name: 'present_file',
    label: 'Present File',
    description: [
      'Present an existing project/workspace file in Tower Viewer Pane as a file-backed artifact.',
      'Use this after creating or identifying an important file the user should see immediately.',
      'This does not create a separate artifact repository; it opens the real file in Tower file UI.',
    ].join(' '),
    promptSnippet: 'Use present_file to show an existing/created project file in the right-side Viewer Pane when the file is an important user-facing artifact.',
    promptGuidelines: [
      'Use present_file for final reports, drafts, generated HTML/Markdown/CSV/JSON, or other project files that the user should inspect immediately.',
      'The path must already exist and must be accessible to the current user/session.',
      'This tool is a presentation cue only: still mention important workspace file paths in the final answer when handing off new/modified files.',
      'Viewer Pane is right-side only. Do not request bottom placement; any legacy split/pane hint is normalized to right.',
    ],
    parameters: PresentFileParams,
    async execute(_toolCallId: string, params: {
      path: string;
      split?: 'right' | 'bottom';
      pane?: 'right' | 'bottom';
      label?: string;
      focus?: boolean;
    }) {
      try {
        if (!ctx.userId) return textResult('present_file failed: authenticated user context is missing.', true);
        const absPath = resolveFilePath(params.path, ctx.cwd);
        if (!await isPathAccessible(absPath, ctx.userId, ctx.userRole || 'member')) {
          return textResult(`present_file failed: path is not accessible: ${absPath}`, true);
        }
        if (ctx.projectId && ctx.projectRoot && ctx.userId) {
          const root = path.resolve(ctx.projectRoot);
          if (absPath === root || !absPath.startsWith(`${root}${path.sep}`)) return textResult(`present_file failed: path is outside the current Project: ${absPath}`, true);
          const reference = await resolveProjectWorkspaceFile({ projectId: ctx.projectId, projectRoot: root, relativePath: path.relative(root, absPath).split(path.sep).join('/') });
          const entry = await projectWorkspaceEntryExists({ reference, actorUserId: ctx.userId });
          if (!entry.exists) return textResult(`present_file failed: path is not an existing file: ${absPath}`, true);
          // Explicit publication, never automatic ACL widening on access failure.
          if (entry.storageAuthority === 'host') {
            try { await fs.access(reference.hostPath, constants.R_OK); }
            catch { return textResult('present_file failed: SHARED_OUTPUT_NOT_READABLE. Explicitly publish the designated non-secret output before presenting it; do not widen private-file ACLs automatically.', true); }
          }
        } else {
          const { promises: fs } = await import('fs');
          const st = await fs.stat(absPath).catch(() => null);
          if (!st?.isFile()) return textResult(`present_file failed: path is not an existing file: ${absPath}`, true);
        }
        const split = normalizeSplit(params.split, params.pane);
        const label = params.label?.trim() || path.basename(absPath);
        return textResult(JSON.stringify({
          ok: true,
          action: 'present_file',
          path: absPath,
          split,
          // `pane` remains for early frontend/result compatibility. New code should read `split`.
          pane: split,
          label,
          focus: params.focus !== false,
          message: `Presented ${label} in Viewer Pane: ${absPath}`,
        }, null, 2));
      } catch (err: any) {
        return textResult(`present_file failed: ${err?.message || String(err)}`, true);
      }
    },
  } as ToolDefinition;
}
