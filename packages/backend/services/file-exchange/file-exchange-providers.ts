// Owns: ACL-preserving adapters for Personal, Session, Channel, and Project bytes. See README.md.
import crypto from 'crypto';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Writable } from 'stream';
import fs from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import path from 'path';
import { config } from '../../config.js';
import { resolvePersonalBinaryFile, readPersonalFile } from '../personal-space/personal-space-store.js';
import { resolveSessionAttachment } from '../session-attachments/session-attachment-store.js';
import { getChannelSharedFile } from '../room/channel-shared-files.js';
import { canAccessRoom, canAccessSession, isPathAccessible, isPathWritableByRole } from '../pm/project-access.js';
import { getProject } from '../pm/project-manager.js';
import type { FileDestinationRef, FileExchangeActor, FileSourceRef } from './file-exchange-types.js';
import { FileExchangeError } from './file-exchange-types.js';

export interface ResolvedFileSource {
  ref: FileSourceRef;
  name: string;
  mimeType: string | null;
  sizeBytes: number;
  version: string;
  sha256: string | null;
  storagePath: string;
}

async function digestFile(storagePath: string): Promise<{ sizeBytes: number; sha256: string }> {
  let sizeBytes = 0;
  const hash = crypto.createHash('sha256');
  await pipeline(createReadStream(storagePath), new Writable({
    write(chunk, _encoding, callback) {
      sizeBytes += chunk.length;
      hash.update(chunk);
      callback();
    },
  }));
  return { sizeBytes, sha256: hash.digest('hex') };
}

function safeName(input: string): string {
  const name = path.basename(input).replace(/[\\/:*?"<>|\0]/g, '-').slice(0, 240);
  if (!name || name === '.' || name === '..') throw new FileExchangeError('INVALID', '파일 이름이 필요합니다.');
  return name;
}

function assertInside(root: string, candidate: string): void {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new FileExchangeError('FORBIDDEN', '저장소 경계를 벗어난 파일입니다.');
  }
}

/** Resolve source authority and optionally measure its bytes for an inspect plan. */
export async function resolveFileSource(
  actor: FileExchangeActor,
  ref: FileSourceRef,
  options: { measureContent?: boolean } = {},
): Promise<ResolvedFileSource> {
  let storagePath: string;
  let name: string;
  let mimeType: string | null;
  let declaredVersion = '';

  if (ref.scope === 'personal') {
    try {
      const binary = await resolvePersonalBinaryFile(actor.userId, ref.uri);
      storagePath = binary.path;
      name = binary.document.name;
      mimeType = binary.document.mimeType;
      declaredVersion = String(binary.document.version);
    } catch (error: any) {
      if (error?.code !== 'INVALID_PATH') throw error;
      const note = await readPersonalFile(actor.userId, ref.uri);
      const root = path.join(config.dataDir, 'personal-spaces', String(actor.userId), 'files');
      storagePath = path.join(root, note.relativePath);
      assertInside(root, storagePath);
      name = note.name;
      mimeType = note.mimeType;
      declaredVersion = String(note.version);
    }
  } else if (ref.scope === 'session') {
    const access = await canAccessSession(ref.sessionId, actor.userId, actor.role);
    if (!access.allowed) throw new FileExchangeError('FORBIDDEN', access.message);
    const resolved = await resolveSessionAttachment(actor.userId, ref.sessionId, ref.attachmentId);
    storagePath = resolved.path;
    name = resolved.document.name;
    mimeType = resolved.document.mimeType;
    declaredVersion = resolved.document.id;
  } else if (ref.scope === 'channel') {
    const access = await canAccessRoom(ref.channelId, actor.userId, actor.role);
    if (!access.allowed) throw new FileExchangeError('FORBIDDEN', access.message);
    const item = await getChannelSharedFile(ref.channelId, ref.fileId);
    if (!item) throw new FileExchangeError('NOT_FOUND', '채널 파일을 찾지 못했습니다.');
    const root = path.join(config.workspaceRoot, 'uploads', 'channels', ref.channelId);
    assertInside(root, item.storagePath);
    storagePath = item.storagePath;
    name = item.originalName;
    mimeType = item.mimeType;
    declaredVersion = `${item.id}:${item.createdAt}`;
  } else {
    const project = await getProject(ref.projectId);
    if (!project?.rootPath) throw new FileExchangeError('NOT_FOUND', 'AI 팀원 작업공간을 찾지 못했습니다.');
    const relativePath = ref.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relativePath || relativePath.split('/').some(part => part === '..')) throw new FileExchangeError('INVALID', '잘못된 Project 파일 경로입니다.');
    storagePath = path.join(project.rootPath, relativePath);
    assertInside(project.rootPath, storagePath);
    if (!await isPathAccessible(storagePath, actor.userId, actor.role)) throw new FileExchangeError('FORBIDDEN', 'Project 파일 접근이 거부되었습니다.');
    name = path.basename(storagePath);
    mimeType = null;
    const stat = await fs.stat(storagePath).catch(() => null);
    if (!stat?.isFile()) throw new FileExchangeError('NOT_FOUND', 'Project 파일을 찾지 못했습니다.');
    declaredVersion = `${stat.size}:${stat.mtimeMs}`;
  }

  if (options.measureContent === false) {
    const stat = await fs.stat(storagePath).catch(() => null);
    if (!stat?.isFile()) throw new FileExchangeError('NOT_FOUND', '원본 파일을 찾지 못했습니다.');
    return { ref, name, mimeType, sizeBytes: stat.size, version: declaredVersion, sha256: null, storagePath };
  }
  const measured = await digestFile(storagePath);
  return { ref, name, mimeType, sizeBytes: measured.sizeBytes, version: declaredVersion, sha256: measured.sha256, storagePath };
}

/** Validate a destination immediately before execution. */
export async function assertFileDestination(actor: FileExchangeActor, destination: FileDestinationRef): Promise<void> {
  if (destination.scope === 'personal') {
    const relativeDir = (destination.relativeDirectory || 'files').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relativeDir || relativeDir.split('/').some(part => part === '..') || relativeDir === 'notes' || relativeDir.startsWith('notes/') || relativeDir === 'archive' || relativeDir.startsWith('archive/')) {
      throw new FileExchangeError('INVALID', '개인 파일 대상 폴더가 올바르지 않습니다.');
    }
    return;
  }
  if (destination.scope === 'session') {
    if (actor.role === 'viewer' || actor.role === 'guest') {
      throw new FileExchangeError('FORBIDDEN', '대화 첨부 쓰기 권한이 없습니다.');
    }
    const access = await canAccessSession(destination.sessionId, actor.userId, actor.role);
    if (!access.allowed) throw new FileExchangeError('FORBIDDEN', access.message);
    return;
  }
  if (destination.scope === 'channel') {
    const access = await canAccessRoom(destination.channelId, actor.userId, actor.role);
    if (!access.allowed) throw new FileExchangeError('FORBIDDEN', access.message);
    return;
  }
  const project = await getProject(destination.projectId);
  if (!project?.rootPath) throw new FileExchangeError('NOT_FOUND', 'AI 팀원 작업공간을 찾지 못했습니다.');
  const relativeDir = (destination.relativeDirectory || 'uploads').replace(/\\/g, '/').replace(/^\/+/, '');
  if (relativeDir.split('/').some(part => part === '..')) throw new FileExchangeError('INVALID', '잘못된 대상 폴더입니다.');
  const targetDir = path.join(project.rootPath, relativeDir);
  assertInside(project.rootPath, targetDir);
  if (!await isPathWritableByRole(targetDir, actor.userId, actor.role)) throw new FileExchangeError('FORBIDDEN', 'AI 팀원 작업공간 쓰기 권한이 없습니다.');
}

/** Return a collision-safe display name without overwriting an existing destination. */
export async function reserveUniqueName(targetDir: string, requestedName: string): Promise<{ name: string; path: string; handle: FileHandle }> {
  const name = safeName(requestedName);
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  await fs.mkdir(targetDir, { recursive: true });
  for (let index = 0; index < 10_000; index++) {
    const candidateName = index === 0 ? name : `${stem} (${index})${ext}`;
    const candidatePath = path.join(targetDir, candidateName);
    try {
      const handle = await fs.open(candidatePath, 'wx', 0o600);
      return { name: candidateName, path: candidatePath, handle };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new FileExchangeError('CONFLICT', '사용 가능한 파일 이름을 만들지 못했습니다.');
}
