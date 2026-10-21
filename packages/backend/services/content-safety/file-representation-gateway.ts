// Owns the mandatory file-source boundary before format-specific tools inspect bytes.
// It resolves project paths and session attachment references, probes bytes once, and
// returns one policy decision. Specialized tools own parsing, never source authority.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  decideAttachmentRepresentation,
  type AttachmentRepresentationDecision,
} from './attachment-representation-policy.js';
import { resolveAuthorizedSessionAttachment } from '../session-attachments/session-attachment-store.js';

export const DEFAULT_PROBE_BYTES = 64 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_DIMENSION = 4096;
const execFileAsync = promisify(execFile);

function imageDimensions(bytes: Buffer, mimeType: string): { width: number; height: number } | null {
  if (mimeType === 'image/png' && bytes.length >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType === 'image/gif' && bytes.length >= 10) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (mimeType === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const segmentLength = bytes.readUInt16BE(offset + 2);
      if (segmentLength < 2 || offset + segmentLength + 2 > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      }
      offset += segmentLength + 2;
    }
  }
  return null;
}

export interface FileRepresentationSource {
  /** Fixed Project authority must own both metadata and byte reads. Never fall back to host fs after a denial. */
  stat: (absolutePath: string) => Promise<{ isFile(): boolean; size: number }>;
  readProbe: (absolutePath: string, maxBytes: number) => Promise<Buffer>;
  /** Required by text Read. The source enforces maxBytes and its own no-follow confinement. */
  readFile: (absolutePath: string, maxBytes: number) => Promise<Buffer>;
}

export interface FileRepresentationContext {
  cwd: string;
  projectRoot?: string;
  sessionId?: string;
  userId?: number;
  /** Installed, already-authorized source for Project files. Requires projectRoot; attachments stay local. */
  projectSource?: FileRepresentationSource;
}

export interface PreparedFileRepresentation {
  source: string;
  path: string;
  name: string;
  sizeBytes: number;
  temporary: boolean;
  decision: AttachmentRepresentationDecision;
}

// Internal source capability; never serialize actor context or host paths as durable authority.
const attachmentContexts = new WeakMap<PreparedFileRepresentation, FileRepresentationContext>();

function isInside(parent: string, candidate: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(resolvedParent + path.sep);
}

function resolvePathSource(source: string, ctx: FileRepresentationContext): string {
  if (!source.trim()) throw new Error('Path is required.');
  if (source === '/workspace' || source.startsWith('/workspace/')) {
    if (!ctx.projectRoot) throw new Error('Runtime Box path /workspace/... requires projectRoot.');
    const resolved = path.resolve(ctx.projectRoot, `.${source.slice('/workspace'.length)}`);
    if (!isInside(ctx.projectRoot, resolved)) throw new Error(`Runtime Box path escapes project root: ${source}`);
    return resolved;
  }
  if (source.startsWith('~/')) return path.resolve(os.homedir(), source.slice(2));
  return path.isAbsolute(source) ? path.resolve(source) : path.resolve(ctx.cwd, source);
}

async function readProbe(filePath: string, maxBytes = DEFAULT_PROBE_BYTES): Promise<Buffer> {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('FILE_SOURCE_NOT_REGULAR');
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function prepareFileRepresentation(
  source: string,
  ctx: FileRepresentationContext,
): Promise<PreparedFileRepresentation> {
  let filePath: string;
  let name: string;
  let temporary = false;

  if (source.startsWith('session://attachments/')) {
    if (!ctx.userId || !ctx.sessionId) throw new Error('Authenticated session context is required for session attachments.');
    const resolved = await resolveAuthorizedSessionAttachment(ctx.userId, ctx.sessionId, source);
    filePath = resolved.path;
    name = resolved.document.name;
    temporary = true;
  } else {
    filePath = resolvePathSource(source, ctx);
    name = path.basename(filePath);
  }

  if (!temporary && ctx.projectSource && (!ctx.projectRoot || !isInside(ctx.projectRoot, filePath))) {
    throw new Error('PROJECT_FILE_SOURCE_OUTSIDE_ROOT');
  }
  const projectSource = temporary ? undefined : ctx.projectSource;
  const [stat, probe] = await Promise.all([
    projectSource ? projectSource.stat(filePath) : fs.stat(filePath),
    projectSource ? projectSource.readProbe(filePath, DEFAULT_PROBE_BYTES) : readProbe(filePath),
  ]);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${source}`);
  const prepared: PreparedFileRepresentation = {
    source,
    path: filePath,
    name,
    sizeBytes: stat.size,
    temporary,
    decision: decideAttachmentRepresentation({ name, bytes: probe }),
  };
  if (temporary) attachmentContexts.set(prepared, { ...ctx });
  return prepared;
}

async function reauthorizePreparedAttachment(prepared: PreparedFileRepresentation): Promise<void> {
  if (!prepared.temporary) return;
  const ctx = attachmentContexts.get(prepared);
  if (!ctx?.userId || !ctx.sessionId || !prepared.source.startsWith('session://attachments/')) {
    throw new Error('SESSION_ATTACHMENT_CAPABILITY_REQUIRED');
  }
  const resolved = await resolveAuthorizedSessionAttachment(ctx.userId, ctx.sessionId, prepared.source);
  if (resolved.path !== prepared.path) throw new Error('SESSION_ATTACHMENT_SOURCE_CHANGED');
}

/** One byte source contract for every format, without Project fallback for attachments. */
export async function readPreparedFileBytes(prepared: PreparedFileRepresentation, source: FileRepresentationSource | undefined, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('FILE_SOURCE_LIMIT_INVALID');
  if (prepared.sizeBytes > maxBytes) throw new Error(`Source exceeds ${maxBytes}-byte limit.`);
  if (!prepared.temporary && source) {
    const bytes = await source.readFile(prepared.path, maxBytes);
    if (bytes.length > maxBytes) throw new Error('FILE_SOURCE_LIMIT_EXCEEDED');
    return bytes;
  }
  await reauthorizePreparedAttachment(prepared);
  const handle = await fs.open(prepared.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('FILE_SOURCE_NOT_REGULAR');
    if (stat.size > maxBytes) throw new Error('FILE_SOURCE_LIMIT_EXCEEDED');
    if (prepared.temporary && stat.size !== prepared.sizeBytes) throw new Error('FILE_SOURCE_CHANGED_DURING_READ');
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset > maxBytes) throw new Error('FILE_SOURCE_LIMIT_EXCEEDED');
    if (offset !== stat.size) throw new Error('FILE_SOURCE_CHANGED_DURING_READ');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

export async function withPreparedLocalFile<T>(
  prepared: PreparedFileRepresentation,
  source: FileRepresentationSource | undefined,
  maxBytes: number,
  use: (localPath: string, metadata: { sha256?: string }) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('PROJECT_FILE_STAGE_LIMIT_INVALID');
  if (prepared.sizeBytes > maxBytes) throw new Error(`Source exceeds the ${maxBytes}-byte staging budget.`);
  if (!source && !prepared.temporary) return use(prepared.path, {});
  const bytes = await readPreparedFileBytes(prepared, source, maxBytes);
  if (bytes.length > maxBytes || bytes.length !== prepared.sizeBytes) throw new Error('FILE_SOURCE_STAGE_SIZE_MISMATCH');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-project-file-stage-'));
  const localPath = path.join(tempDir, path.basename(prepared.name));
  try {
    await fs.writeFile(localPath, bytes, { flag: 'wx', mode: 0o600 });
    return await use(localPath, { sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export function requireDetectedMime(
  prepared: PreparedFileRepresentation,
  accepted: readonly string[],
  toolName: string,
): PreparedFileRepresentation {
  if (!prepared.decision.detectedMimeType || !accepted.includes(prepared.decision.detectedMimeType)) {
    throw new Error(`${toolName} cannot process ${prepared.name}: detected ${prepared.decision.detectedMimeType || prepared.decision.classification}.`);
  }
  return prepared;
}

async function normalizeVisionImage(prepared: PreparedFileRepresentation): Promise<{ data: Buffer; mimeType: 'image/png' | 'image/jpeg' }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-image-normalize-'));
  const output = path.join(tempDir, 'normalized.png');
  const python = process.env.TOWER_DOCUMENT_PYTHON || 'python3';
  const script = [
    'from PIL import Image, ImageOps',
    'import sys',
    'source, output, max_dim = sys.argv[1], sys.argv[2], int(sys.argv[3])',
    'with Image.open(source) as original:',
    '    original.seek(0)',
    '    image = ImageOps.exif_transpose(original)',
    '    image.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)',
    "    if image.mode not in ('RGB', 'RGBA'): image = image.convert('RGBA')",
    "    image.save(output, format='PNG', optimize=True)",
  ].join('\n');
  try {
    await execFileAsync(python, ['-c', script, prepared.path, output, String(MAX_IMAGE_DIMENSION)], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    return { data: await fs.readFile(output), mimeType: 'image/png' };
  } catch (error) {
    throw new Error(`Image safe decode/reencode failed: ${(error as Error).message}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function readPreparedVisionImage(prepared: PreparedFileRepresentation, source?: FileRepresentationSource) {
  if (prepared.decision.modelMode !== 'vision' || !prepared.decision.detectedMimeType?.startsWith('image/')) {
    return null;
  }
  const maxBytes = prepared.decision.limits.maxDecodedBytes;
  if (maxBytes !== undefined && prepared.sizeBytes > maxBytes) {
    throw new Error(`Image exceeds the ${maxBytes}-byte model representation budget.`);
  }
  return withPreparedLocalFile(prepared, source, maxBytes ?? 20 * 1024 * 1024, async localPath => {
    // Parser-local capability: not a session source and never handed to Project tools.
    const localPrepared = localPath === prepared.path ? prepared : { ...prepared, path: localPath };
    const bytes = await fs.readFile(localPath);
    const dimensions = imageDimensions(bytes.subarray(0, DEFAULT_PROBE_BYTES), prepared.decision.detectedMimeType!);
    if (dimensions && (dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS)) {
      throw new Error(`Image dimensions exceed the ${MAX_IMAGE_PIXELS}-pixel model representation budget.`);
    }
    const normalized = await normalizeVisionImage(localPrepared);
    if (maxBytes !== undefined && normalized.data.length > maxBytes) {
      throw new Error(`Normalized image exceeds the ${maxBytes}-byte model representation budget.`);
    }
    return {
      type: 'image' as const,
      data: normalized.data.toString('base64'),
      mimeType: normalized.mimeType,
    };
  });
}
