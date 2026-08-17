// Owns bounded classification of file bytes before they become LLM-visible tool output.
// Storage is intentionally out of scope: unsafe/unknown files remain stored and become reference-only.

import path from 'node:path';

export type AttachmentClassification = 'text' | 'image' | 'document' | 'archive' | 'opaque';
export type AttachmentModelMode = 'reference-only' | 'bounded-text' | 'vision' | 'tool-required';

export interface AttachmentRepresentationDecision {
  classification: AttachmentClassification;
  modelMode: AttachmentModelMode;
  detectedMimeType: string | null;
  reason: string;
  policyVersion: 'attachment-representation-v1';
  limits: { maxChars?: number; maxDecodedBytes?: number; maxPages?: number; maxItems?: number };
}

const TEXT_PREVIEW_BYTES = 50 * 1024;
const BASE64_RUN = /[A-Za-z0-9+/=_-]{8192,}/;
const DATA_URI = /data:[\w.+-]+\/[\w.+-]+(?:;[^,\s]*)?;base64,/i;

function startsWith(bytes: Buffer, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function imageMime(bytes: Buffer): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function archiveMime(bytes: Buffer): string | null {
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return 'application/zip';
  if (startsWith(bytes, [0x1f, 0x8b])) return 'application/gzip';
  if (startsWith(bytes, [0x28, 0xb5, 0x2f, 0xfd])) return 'application/zstd';
  if (startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'application/x-7z-compressed';
  return null;
}

function looksLikeText(bytes: Buffer): { safe: boolean; reason: string; text: string } {
  const probe = bytes.subarray(0, Math.min(bytes.length, TEXT_PREVIEW_BYTES));
  if (probe.includes(0)) return { safe: false, reason: 'NUL byte detected', text: '' };
  const text = probe.toString('utf8');
  const replacementCount = [...text].filter(char => char === '\ufffd').length;
  if (replacementCount > Math.max(2, text.length * 0.01)) return { safe: false, reason: 'invalid UTF-8 ratio', text };
  const controlCount = [...text].filter(char => {
    const code = char.charCodeAt(0);
    return code < 32 && char !== '\n' && char !== '\r' && char !== '\t';
  }).length;
  if (controlCount > Math.max(4, text.length * 0.01)) return { safe: false, reason: 'binary control-character ratio', text };
  if (DATA_URI.test(text) || BASE64_RUN.test(text)) return { safe: false, reason: 'large embedded binary payload', text };
  const longestLine = text.split(/\r?\n/).reduce((max, line) => Math.max(max, line.length), 0);
  if (longestLine > TEXT_PREVIEW_BYTES) return { safe: false, reason: 'single line exceeds bounded preview', text };
  return { safe: true, reason: 'bounded UTF-8 text', text };
}

export function decideAttachmentRepresentation(input: { name: string; bytes: Buffer }): AttachmentRepresentationDecision {
  const extension = path.extname(input.name).toLowerCase();
  const detectedImage = imageMime(input.bytes);
  if (detectedImage) {
    return { classification: 'image', modelMode: 'vision', detectedMimeType: detectedImage, reason: 'supported image magic bytes', policyVersion: 'attachment-representation-v1', limits: { maxDecodedBytes: 8 * 1024 * 1024, maxItems: 4 } };
  }

  const detectedArchive = archiveMime(input.bytes);
  if (detectedArchive) {
    const office = ['.pptx', '.docx', '.xlsx'].includes(extension);
    return { classification: office ? 'document' : 'archive', modelMode: 'tool-required', detectedMimeType: detectedArchive, reason: office ? 'Office container requires a dedicated parser' : 'archive magic bytes', policyVersion: 'attachment-representation-v1', limits: { maxItems: 20 } };
  }

  if (startsWith(input.bytes, [0x25, 0x50, 0x44, 0x46])) {
    return { classification: 'document', modelMode: 'tool-required', detectedMimeType: 'application/pdf', reason: 'PDF requires bounded page rendering/extraction', policyVersion: 'attachment-representation-v1', limits: { maxPages: 4 } };
  }

  const text = looksLikeText(input.bytes);
  if (text.safe) {
    return { classification: 'text', modelMode: 'bounded-text', detectedMimeType: 'text/plain', reason: text.reason, policyVersion: 'attachment-representation-v1', limits: { maxChars: TEXT_PREVIEW_BYTES } };
  }

  return { classification: 'opaque', modelMode: 'reference-only', detectedMimeType: null, reason: text.reason, policyVersion: 'attachment-representation-v1', limits: {} };
}

export function attachmentReferenceOnlyNotice(name: string, decision: AttachmentRepresentationDecision): string {
  return `[File stored but not inlined: ${name}; classification=${decision.classification}; reason=${decision.reason}. Use a dedicated parser or inspection tool.]`;
}
