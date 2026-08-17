// Owns the mandatory file-source boundary before format-specific tools inspect bytes.
// It resolves project paths and session attachment references, probes bytes once, and
// returns one policy decision. Specialized tools own parsing, never source authority.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  decideAttachmentRepresentation,
  type AttachmentRepresentationDecision,
} from './attachment-representation-policy.js';
import { resolveSessionAttachment } from '../session-attachments/session-attachment-store.js';

const DEFAULT_PROBE_BYTES = 64 * 1024;
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

export interface FileRepresentationContext {
  cwd: string;
  projectRoot?: string;
  sessionId?: string;
  userId?: number;
}

export interface PreparedFileRepresentation {
  source: string;
  path: string;
  name: string;
  sizeBytes: number;
  temporary: boolean;
  decision: AttachmentRepresentationDecision;
}

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
  const handle = await fs.open(filePath, 'r');
  try {
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
    const resolved = await resolveSessionAttachment(ctx.userId, ctx.sessionId, source);
    filePath = resolved.path;
    name = resolved.document.name;
    temporary = true;
  } else {
    filePath = resolvePathSource(source, ctx);
    name = path.basename(filePath);
  }

  const [stat, probe] = await Promise.all([fs.stat(filePath), readProbe(filePath)]);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${source}`);
  return {
    source,
    path: filePath,
    name,
    sizeBytes: stat.size,
    temporary,
    decision: decideAttachmentRepresentation({ name, bytes: probe }),
  };
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

export async function readPreparedVisionImage(prepared: PreparedFileRepresentation) {
  if (prepared.decision.modelMode !== 'vision' || !prepared.decision.detectedMimeType?.startsWith('image/')) {
    return null;
  }
  const maxBytes = prepared.decision.limits.maxDecodedBytes;
  if (maxBytes !== undefined && prepared.sizeBytes > maxBytes) {
    throw new Error(`Image exceeds the ${maxBytes}-byte model representation budget.`);
  }
  const source = await fs.readFile(prepared.path);
  const dimensions = imageDimensions(source.subarray(0, DEFAULT_PROBE_BYTES), prepared.decision.detectedMimeType);
  if (dimensions && (dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS)) {
    throw new Error(`Image dimensions exceed the ${MAX_IMAGE_PIXELS}-pixel model representation budget.`);
  }
  const normalized = await normalizeVisionImage(prepared);
  if (maxBytes !== undefined && normalized.data.length > maxBytes) {
    throw new Error(`Normalized image exceeds the ${maxBytes}-byte model representation budget.`);
  }
  return {
    type: 'image' as const,
    data: normalized.data.toString('base64'),
    mimeType: normalized.mimeType,
  };
}
