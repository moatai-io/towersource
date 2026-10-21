// Owns: authorized explicit project upload through Project workspace authority.
import path from 'node:path';
import crypto from 'node:crypto';
import { SessionAttachmentError } from './session-attachment-store.js';
import { getProject } from '../pm/project-manager.js';
import { isPathWritableByRole } from '../pm/project-access.js';
import { commitProjectWorkspaceFile } from '../project-environment/project-workspace-files.js';

function safeProjectUploadName(input: string): string {
  const base = path.basename(String(input || '').trim()).replace(/[\\/:*?"<>|\0]/g, '-').slice(0, 240);
  if (!base || base === '.' || base === '..') throw new SessionAttachmentError('INVALID', 'Attachment filename required');
  return base;
}

export async function commitStagedProjectUpload(input: {
  sourcePath: string;
  originalName: string;
  mimeType?: string | null;
  sizeBytes: number;
  projectId: string;
  userId: number;
  userRole: string;
}) {
  const project = await getProject(input.projectId);
  if (!project?.rootPath) throw new SessionAttachmentError('NOT_FOUND', 'Project not found');
  const targetDir = path.join(project.rootPath, 'uploads');
  if (!await isPathWritableByRole(targetDir, input.userId, input.userRole)) {
    throw new SessionAttachmentError('FORBIDDEN', 'Project upload access denied');
  }
  const name = safeProjectUploadName(input.originalName);
  const committed = await commitProjectWorkspaceFile({
    projectId: input.projectId,
    relativeDirectory: 'uploads',
    requestedName: name,
    sourcePath: input.sourcePath,
    sizeBytes: input.sizeBytes,
    actorUserId: input.userId,
  });
  const target = path.join(project.rootPath, committed.relativePath);
  return {
    id: crypto.randomUUID(),
    uri: target,
    name: committed.name,
    mimeType: input.mimeType || null,
    sizeBytes: input.sizeBytes,
    status: 'project_file' as const,
    promotedUri: target,
    expiresAt: null,
    createdAt: new Date().toISOString(),
  };
}
