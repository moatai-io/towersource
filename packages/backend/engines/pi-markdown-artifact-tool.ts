/** Markdown documents are ordinary Project files, delivered through the shared Viewer intent. */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { assertSessionAllowsSharedArtifactWrite } from '../services/session/session-artifact-privacy.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { isPathAccessible, isPathWritableByRole, resolvePathForAccessBoundary } from '../services/pm/project-access.js';
import {
  compareAndSwapProjectWorkspaceText,
  createProjectWorkspaceDirectory,
  projectWorkspaceEntryExists,
  readProjectWorkspaceFileBytes,
  resolveProjectWorkspaceFile,
  writeProjectWorkspaceText,
} from '../services/project-environment/project-workspace-files.js';

export function createMarkdownArtifactTool(ctx: { cwd: string; projectId?: string; projectRoot?: string; userId?: number; userRole?: string; sessionId?: string }, mode: 'create' | 'read' | 'update' = 'create'): ToolDefinition {
  return {
    name: `${mode}_markdown_artifact`,
    label: mode === 'read' ? '문서 읽기' : mode === 'update' ? '문서 수정' : '문서 작성',
    description: mode === 'read' ? 'Read a complete existing Markdown document and its exact SHA-256 for safe updating.' : mode === 'update' ? 'Replace an existing Markdown document with the full revised body only if expectedSha256 matches. Opens the saved file in Viewer; summarize changes in about five lines, without repeating the body. Read first; user-requested edits need no extra overwrite approval.' : 'Create a new user-facing Markdown document once: save the ordinary Project file and open it in Viewer Pane; summarize in about five lines without repeating the body. Never overwrites different content. Not for internal records or editing existing documents.',
    promptSnippet: mode !== 'create' ? 'For existing document revisions, read_markdown_artifact first, then update_markdown_artifact with its sha256 and complete revised body. Do not repeat the body in chat.' : 'Use create_markdown_artifact for new user-facing Markdown deliverables; never repeat the body in chat or write it separately.',
    promptGuidelines: ['Failures are scoped to this document operation, not proof that all Project writes are unavailable. Use code/recoverable/suggestedAction for recovery within the authorized Project. Never bypass permissions. Report final save status and needed user action, not internal error codes or stacks.', mode === 'read' ? 'Returns the exact current body and sha256. Preserve unrelated content when revising. Pass this sha256 to update_markdown_artifact; on conflict reread and reconcile, never blindly replace the hash.' : 'The tool saves one ordinary Project file and requests Viewer display through the shared presentation flow. A receipt confirms saving and a display request, not browser acknowledgment; never claim the browser has opened without acknowledgment. Do not write a second copy or call present_file again. In chat, summarize the result or changes in about five lines; show the full body only if explicitly requested. Default to the current Project and preserve normal file access guards. Use safe read/update for revisions; ordinary file tools remain appropriate for internal records and explicit file-only requests.'],
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 2000, description: 'Markdown path. Relative paths resolve in the current Project; an explicitly requested absolute path is allowed only under normal file access/write policy. Follow the existing folder structure.' }),
      ...(mode === 'read' ? {} : { title: Type.String({ minLength: 1, maxLength: 160 }), body: Type.String({ minLength: 1, maxLength: 500000 }) }),
      ...(mode === 'update' ? { expectedSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }) } : {}),
    }),
    async execute(_toolCallId: string, params: { path: string; title?: string; body?: string; expectedSha256?: string }) {
      let root = '';
      let target = '';
      const fail = (code: string, message: string): never => { const error: any = new Error(message); error.code = code; throw error; };
      const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
      const result = (payload: any, isError = false): any => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], isError });
      try {
        if (mode !== 'read') await assertSessionAllowsSharedArtifactWrite(ctx.sessionId);
        if (!ctx.userId || !ctx.projectRoot) fail('access_context_required', '현재 사용자와 Project 접근 정보가 필요합니다.');
        if (!/\.md$/i.test(params.path)) fail('unsupported_extension', 'Markdown 문서는 .md 확장자를 사용하세요.');
        if (/^[A-Za-z]:[\\/]/.test(params.path) || (!path.isAbsolute(params.path) && params.path.split(/[\\/]/).includes('..'))) fail('unsafe_path', '상위 경로 이동은 허용되지 않습니다.');
        const projectRoot = ctx.projectRoot!;
        root = await fs.realpath(projectRoot);
        target = path.resolve(root, params.path);
        const check = async () => {
          const resolved = resolvePathForAccessBoundary(target);
          if (!await isPathAccessible(resolved, ctx.userId!, ctx.userRole || 'member')) fail('access_denied', '실제 파일 경로에 접근할 권한이 없습니다.');
          if (mode !== 'read' && !await isPathWritableByRole(resolved, ctx.userId!, ctx.userRole || 'member')) fail('write_denied', '실제 파일 경로에 문서를 저장할 권한이 없습니다.');
          if (!await isPathAccessible(target, ctx.userId!, ctx.userRole || 'member')) fail('access_denied', '이 경로에 접근할 권한이 없습니다.');
          if (mode !== 'read' && !await isPathWritableByRole(target, ctx.userId!, ctx.userRole || 'member')) fail('write_denied', '이 경로에 문서를 저장할 권한이 없습니다.');
        };
        await check();
        if (mode !== 'read' && (!params.title?.trim() || !params.body?.trim())) fail('content_required', 'title과 body가 필요합니다.');
        if (mode === 'update' && !/^[a-f0-9]{64}$/.test(params.expectedSha256 || '')) fail('expected_sha_required', 'update에는 read_markdown_artifact가 반환한 expectedSha256이 필요합니다.');
        const insideProject = target !== root && target.startsWith(`${root}${path.sep}`);
        const body = mode === 'read' ? undefined : (params.body!.endsWith('\n') ? params.body! : `${params.body!}\n`);
        if (!insideProject) {
          if (mode === 'read') { const current = await fs.readFile(target, 'utf8'); return result({ ok: true, path: params.path, body: current, sha256: hash(current) }); }
          if (mode === 'create') {
            await fs.mkdir(path.dirname(target), { recursive: true });
            try { await fs.writeFile(target, body!, { encoding: 'utf8', flag: 'wx' }); }
            catch (error: any) { if (error.code !== 'EEXIST' || await fs.readFile(target, 'utf8') !== body) throw error; }
          } else {
            const current = await fs.readFile(target, 'utf8');
            if (current !== body && hash(current) !== params.expectedSha256) fail('version_conflict', '문서가 다른 실행에서 변경되었습니다. 다시 읽고 변경 사항을 병합하세요.');
            if (current !== body) await fs.writeFile(target, body!, 'utf8');
          }
          return result({ ok: true, action: 'present_file', artifact: 'markdown', presentation: 'viewer', reveal: true, split: 'right', operation: mode, path: target, label: params.title, status: 'saved', sha256: hash(body!), focus: mode === 'create' });
        }
        const relativePath = path.relative(root, target).split(path.sep).join('/');
        if (!ctx.projectId) fail('project_storage_required', 'Project 내부 Markdown은 Project storage authority가 필요합니다.');
        const projectId = ctx.projectId!;
        const reference = await resolveProjectWorkspaceFile({ projectId, projectRoot: root, relativePath });
        const readCurrent = async () => {
          const bytes = (await readProjectWorkspaceFileBytes({ reference, actorUserId: ctx.userId!, maxBytes: 50 * 1024 * 1024 })).bytes;
          return bytes.toString('utf8');
        };
        const exists = async () => (await projectWorkspaceEntryExists({ reference, actorUserId: ctx.userId! })).exists;
        if (mode === 'read') {
          if (!await exists()) fail('not_found', '문서를 찾을 수 없습니다.');
          const body = await readCurrent();
          return result({ ok: true, action: 'markdown_read', artifact: 'markdown', operation: 'read', path: target, label: path.basename(target), status: 'read', sha256: hash(body), body, focus: false });
        }
        if (mode === 'create') {
          if (await exists()) {
            if (await readCurrent() !== body!) fail('already_exists', '이미 존재하는 문서입니다. 수정하려면 read_markdown_artifact와 update_markdown_artifact를 사용하세요.');
            return result({ ok: true, action: 'present_file', artifact: 'markdown', presentation: 'viewer', reveal: true, split: 'right', operation: mode, path: target, label: params.title, status: 'saved', sha256: hash(body!), focus: mode === 'create' });
          }
          const parent = path.posix.dirname(relativePath);
          if (parent !== '.') {
            const directory = await resolveProjectWorkspaceFile({ projectId, projectRoot: root, relativePath: parent });
            await createProjectWorkspaceDirectory({ reference: directory, actorUserId: ctx.userId!, exclusive: false });
          }
          await writeProjectWorkspaceText({ reference, actorUserId: ctx.userId!, content: body!, exclusive: true });
        } else {
          if (!await exists()) fail('not_found', '문서를 찾을 수 없습니다.');
          const current = await readCurrent();
          if (current === body!) return result({ ok: true, action: 'present_file', artifact: 'markdown', presentation: 'viewer', reveal: true, split: 'right', operation: mode, path: target, label: params.title, status: 'saved', sha256: hash(body!), focus: false });
          if (hash(current) !== params.expectedSha256) fail('version_conflict', '문서가 다른 실행에서 변경되었습니다. 다시 읽고 변경 사항을 병합하세요.');
          await compareAndSwapProjectWorkspaceText({ reference, actorUserId: ctx.userId!, expectedContent: current, content: body! });
        }
        return result({ ok: true, action: 'present_file', artifact: 'markdown', presentation: 'viewer', reveal: true, split: 'right', operation: mode, path: target, label: params.title, status: 'saved', sha256: hash(body!), focus: mode === 'create' });
      } catch (error: any) {
        const message = String(error?.message || '');
        const filesystemCode = /\b(ENOENT|EACCES|EPERM|EEXIST)\b/.exec(message)?.[1];
        const code = error?.code || filesystemCode || (/ACCESS_REVOKED|ACCESS_DENIED|SCOPE_MISMATCH/.test(message) ? 'WRITE_ACCESS_DENIED' : 'markdown_operation_failed');
        const recoverable = code === 'ENOENT' || code === 'version_conflict';
        const suggestedAction = code === 'private_shared_storage_denied' ? 'keep_in_conversation' : code === 'ENOENT' ? 'check_parent_and_retry' : code === 'version_conflict' ? 'reread_and_reconcile' : ['EACCES', 'EPERM', 'WRITE_ACCESS_DENIED', 'write_denied', 'read_denied'].includes(code) ? 'request_authorized_access' : 'inspect_operation';
        // Never return provider stacks or arbitrary filesystem stderr to the UI/model.
        const userMessage = code === 'private_shared_storage_denied' ? '비공개 대화의 문서는 공용 Project 폴더에 저장할 수 없습니다. 내용을 이 대화에 남겨 주세요.' : ['EACCES', 'EPERM', 'WRITE_ACCESS_DENIED', 'write_denied', 'read_denied'].includes(code) ? '이 문서에 접근할 권한이 없습니다.' : code === 'version_conflict' ? '문서가 변경되었습니다. 최신 내용을 확인한 뒤 저장해야 합니다.' : mode === 'read' ? '문서를 읽지 못했습니다.' : '문서를 파일로 저장하지 못했습니다.';
        return result({ ok: false, code, recoverable, suggestedAction, userMessage }, true);
      }
    },
  } as ToolDefinition;
}
