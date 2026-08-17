/**
 * Converts Tower's canonical DB-stored Claude-style content blocks into
 * the Pi SDK's `Message` vocabulary so PiEngine can ingest a session's
 * history during a Hard Switch.
 *
 * See: workspace/decisions/2026-05-19-engine-hard-switch-design.md
 *      packages/backend/engines/types.ts  (RehydrateInputMessage)
 *      node_modules/@earendil-works/pi-ai/dist/types.d.ts  (Message family)
 *
 * Mostly loss-tolerant by design (called out in decision doc §"핵심 원칙" #3):
 *   - thinking blocks are already stripped at DB write time (message-store.ts
 *     compactContent) — we never see them here.
 *   - cache_control / Anthropic-only metadata is silently dropped.
 *   - image blob_refs are rehydrated into ImageContent when possible.
 *   - PDF document blob_refs are rehydrated as representative page images because
 *     Pi's message vocabulary has ImageContent but no DocumentContent.
 *   - tool_use IDs are preserved verbatim. Pi treats them as opaque strings;
 *     the only invariant the SDK cares about is that toolCallId on a
 *     ToolResultMessage matches a ToolCall earlier in the sequence.
 *
 * Owns: TowerContentBlock[] → Pi Message[] conversion.
 * Public API: convertTowerMessagesToPi, convertOneTowerMessageToPi.
 * Pure function: no fs, no network, no SDK calls. Safe to unit-test in
 * isolation and reuse from other engines that target Pi format.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { Message, TextContent, ImageContent, ToolCall, AssistantMessage, UserMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import type { RehydrateInputMessage } from '../types.js';
import { sanitizeEmbeddedBinaryText } from '../../services/content-safety/embedded-binary.js';
import { isInlineBinaryExternalizationNeeded } from '../pi/session-blob-store.js';

const BLOB_DIR = path.join(process.cwd(), 'data', 'blobs');
const MAX_REHYDRATED_PDF_PAGES = 4;
const MAX_REHYDRATED_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Conversion options. Defaults give a safe, lossy-but-LLM-valid Pi sequence.
 */
export interface TowerToPiOptions {
  /**
   * Model identifier to stamp on AssistantMessage entries (Pi requires it as
   * a non-empty string). Pass the session's last known `model_used` when
   * available; otherwise `'rehydrated'` is fine — it's metadata, not sent to
   * the LLM. See AssistantMessage definition in pi-ai/dist/types.d.ts.
   */
  model?: string;
  /** Same applies to provider / api. Placeholders are accepted by Pi. */
  provider?: string;
  api?: string;
  /** Present only when materializing a durable Pi JSONL during rehydration. */
  sessionFilePath?: string;
}

const DEFAULT_OPTS: Required<Omit<TowerToPiOptions, 'sessionFilePath'>> = {
  model: 'rehydrated',
  provider: 'rehydrated',
  api: 'rehydrated',
};

/**
 * Convert one stored TowerMessage into 0..N Pi messages.
 *
 * The 1→N expansion happens for user rows that contain multiple tool_result
 * blocks: Pi keeps each ToolResultMessage as its own top-level entry, while
 * Claude/Tower groups them under a single user role. We split.
 *
 * Returns `[]` for messages that have no LLM-visible content after lossy
 * conversion (e.g. a user row that was nothing but a stripped thinking block).
 * Callers should filter empties.
 */
export function convertOneTowerMessageToPi(
  msg: RehydrateInputMessage,
  opts: TowerToPiOptions = {},
): Message[] {
  const o = { ...DEFAULT_OPTS, ...opts };
  const timestamp = msg.timestamp ?? Date.now();

  if (msg.role === 'user') {
    // Split into tool_result messages + a possible plain-user message.
    const toolResults: ToolResultMessage[] = [];
    const userContent: (TextContent | ImageContent)[] = [];

    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'tool_result') {
        toolResults.push(toolResultFromBlock(block, timestamp, o.sessionFilePath));
        continue;
      }

      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        userContent.push({ type: 'text', text: sanitizeEmbeddedBinaryText(block.text) });
        continue;
      }

      // Rehydration is a derived, lossy session. Keep small images usable, but
      // never copy incident-sized binary payloads into the new Pi JSONL.
      if (block.type === 'image') {
        const placeholder = imagePlaceholder(block, o.sessionFilePath);
        if (placeholder) userContent.push(placeholder);
        continue;
      }
      if (block.type === 'document') {
        userContent.push(...documentContent(block, o.sessionFilePath));
        continue;
      }

      // Unknown / future block types — drop silently rather than fail the
      // whole rehydrate. We've already lost thinking/cache_control upstream;
      // one more drop is consistent with the lossy contract.
    }

    const out: Message[] = [...toolResults];
    if (userContent.length > 0) {
      // Pi accepts string OR array for UserMessage.content. We always emit
      // an array — simpler invariant, no ambiguity.
      const userMsg: UserMessage = {
        role: 'user',
        content: userContent,
        timestamp,
      };
      out.push(userMsg);
    }
    return out;
  }

  // role === 'assistant'
  const assistantContent: (TextContent | ToolCall)[] = [];
  for (const [blockIndex, block] of msg.content.entries()) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'commentary' && block.visibility === 'progress' && typeof block.text === 'string' && block.text.length > 0) {
      assistantContent.push({
        type: 'text',
        text: sanitizeEmbeddedBinaryText(block.text),
        textSignature: JSON.stringify({ v: 1, id: `${msg.id}_commentary_${blockIndex}`, phase: 'commentary' }),
      });
      continue;
    }

    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      assistantContent.push({ type: 'text', text: sanitizeEmbeddedBinaryText(block.text) });
      continue;
    }

    if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      assistantContent.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: (block.input && typeof block.input === 'object') ? block.input : {},
      });
      continue;
    }

    // thinking and hidden commentary shouldn't be here (stripped at DB write)
    // but guard anyway. cache_control / private signatures: never relevant for Pi.
  }

  if (assistantContent.length === 0) {
    // An assistant row with no surviving content (e.g. thinking-only that
    // somehow slipped through). Skip — emitting an empty AssistantMessage
    // would fail Pi's schema and add no value.
    return [];
  }

  const assistant: AssistantMessage = {
    role: 'assistant',
    content: assistantContent,
    // Required placeholders. Not sent to the LLM during context build —
    // buildSessionContext only forwards content[]. UI uses them for display.
    api: o.api as AssistantMessage['api'],
    provider: o.provider as AssistantMessage['provider'],
    model: o.model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp,
  };
  return [assistant];
}

/**
 * Convert a chronological sequence of TowerMessages to a Pi Message[] suitable
 * for feeding into SessionManager.appendMessage() one at a time.
 *
 * Caller invariant: `messages` is already in chronological order
 * (created_at ASC) and contains no hidden/system markers.
 */
export function convertTowerMessagesToPi(
  messages: ReadonlyArray<RehydrateInputMessage>,
  opts: TowerToPiOptions = {},
): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    out.push(...convertOneTowerMessageToPi(m, opts));
  }
  return out;
}

// ── helpers ────────────────────────────────────────────────────────

function toolResultFromBlock(block: any, timestamp: number, sessionFilePath?: string): ToolResultMessage {
  // Claude tool_result.content can be:
  //   - string
  //   - Array<{type:'text', text} | {type:'image', source}>
  let content: (TextContent | ImageContent)[];

  if (typeof block.content === 'string') {
    content = [{ type: 'text', text: sanitizeEmbeddedBinaryText(block.content) }];
  } else if (Array.isArray(block.content)) {
    content = [];
    for (const inner of block.content) {
      if (!inner || typeof inner !== 'object') continue;
      if (inner.type === 'text' && typeof inner.text === 'string') {
        content.push({ type: 'text', text: sanitizeEmbeddedBinaryText(inner.text) });
      } else if (inner.type === 'image') {
        const ph = imagePlaceholder(inner, sessionFilePath);
        if (ph) content.push(ph);
      }
    }
    if (content.length === 0) {
      content = [{ type: 'text', text: '[empty tool_result]' }];
    }
  } else {
    content = [{ type: 'text', text: '[unrecognized tool_result content]' }];
  }

  return {
    role: 'toolResult',
    toolCallId: typeof block.tool_use_id === 'string' ? block.tool_use_id : 'unknown',
    // Pi's ToolResultMessage.toolName has no analogue in Claude tool_result blocks
    // — Claude relies on tool_use_id correlation. Use empty string; Pi tolerates it.
    toolName: typeof block.name === 'string' ? block.name : '',
    content,
    isError: block.is_error === true,
    timestamp,
  };
}

/**
 * Image block → Pi ImageContent if the data is inline base64.
 * Returns a text placeholder (as TextContent) if the block is a blob_ref or
 * otherwise can't be inlined. Returns null only if the block is malformed
 * beyond recovery — caller drops it.
 */
function imagePlaceholder(block: any, sessionFilePath?: string): TextContent | ImageContent | null {
  const source = block.source;
  if (source && source.type === 'base64' && typeof source.data === 'string' && source.data.length > 0) {
    const mimeType = typeof source.media_type === 'string' ? source.media_type : 'image/png';
    const byteLength = Buffer.byteLength(source.data, 'base64');
    if (sessionFilePath && isInlineBinaryExternalizationNeeded(byteLength)) {
      return { type: 'text', text: `[image omitted from rehydrated session: ${mimeType}; size=${byteLength}]` };
    }
    return { type: 'image', data: source.data, mimeType };
  }
  if (source && source.type === 'blob_ref' && typeof source.path === 'string') {
    const restored = imageContentFromBlob(source.path, typeof source.media_type === 'string' ? source.media_type : undefined);
    if (restored) return restored;
    return {
      type: 'text',
      text: `[image attached: ${source.path} — blob file unavailable or too large to hydrate]`,
    };
  }
  return null;
}

function documentContent(block: any, sessionFilePath?: string): (TextContent | ImageContent)[] {
  const source = block.source;
  const label = describeAttachment(block);

  if (source && source.type === 'base64' && typeof source.data === 'string' && source.data.length > 0) {
    if (String(source.media_type || '').includes('pdf')) {
      const rendered = limitRehydratedImages(renderPdfBufferToImages(Buffer.from(source.data, 'base64'), label), sessionFilePath);
      if (rendered.length > 0) return rendered;
    }
    return [{ type: 'text', text: `[document attached: ${label}]` }];
  }

  if (source && source.type === 'blob_ref' && typeof source.path === 'string') {
    const mediaType = typeof source.media_type === 'string' ? source.media_type : '';
    if (mediaType.includes('pdf') || source.path.toLowerCase().endsWith('.pdf')) {
      const abs = resolveBlobPath(source.path);
      if (abs) {
        const rendered = limitRehydratedImages(renderPdfFileToImages(abs, label), sessionFilePath);
        if (rendered.length > 0) return [
          { type: 'text', text: `[PDF attached: ${label} — first ${rendered.length} page image(s) rehydrated for vision]` },
          ...rendered,
        ];
      }
    }
  }

  return [{ type: 'text', text: `[document attached: ${label}]` }];
}

function limitRehydratedImages(images: ImageContent[], sessionFilePath?: string): (TextContent | ImageContent)[] {
  if (!sessionFilePath) return images;
  return images.map((image, index) => {
    const byteLength = Buffer.byteLength(image.data, 'base64');
    return isInlineBinaryExternalizationNeeded(byteLength)
      ? { type: 'text' as const, text: `[PDF page ${index + 1} omitted from rehydrated session: ${image.mimeType}; size=${byteLength}]` }
      : image;
  });
}

function resolveBlobPath(blobPath: string): string | null {
  const abs = path.resolve(BLOB_DIR, blobPath);
  if (!abs.startsWith(BLOB_DIR + path.sep) && abs !== BLOB_DIR) return null;
  return fs.existsSync(abs) ? abs : null;
}

function imageContentFromBlob(blobPath: string, mediaType?: string): ImageContent | null {
  const abs = resolveBlobPath(blobPath);
  if (!abs) return null;
  const stat = fs.statSync(abs);
  if (stat.size > MAX_REHYDRATED_IMAGE_BYTES) return null;
  return {
    type: 'image',
    data: fs.readFileSync(abs).toString('base64'),
    mimeType: mediaType || mimeTypeFromPath(abs),
  };
}

function renderPdfBufferToImages(pdf: Buffer, label: string): ImageContent[] {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-pi-pdf-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  try {
    fs.writeFileSync(pdfPath, pdf);
    return renderPdfFileToImages(pdfPath, label, tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function renderPdfFileToImages(pdfPath: string, label: string, existingTmpDir?: string): ImageContent[] {
  const tmpDir = existingTmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'tower-pi-pdf-'));
  const prefix = path.join(tmpDir, 'page');
  try {
    execFileSync('pdftoppm', ['-png', '-r', '144', '-f', '1', '-l', String(MAX_REHYDRATED_PDF_PAGES), pdfPath, prefix], {
      stdio: 'ignore',
      timeout: 20_000,
    });
    const files = fs.readdirSync(tmpDir)
      .filter(f => /^page-\d+\.png$/.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .slice(0, MAX_REHYDRATED_PDF_PAGES);
    return files.map((file, idx) => ({
      type: 'image' as const,
      data: fs.readFileSync(path.join(tmpDir, file)).toString('base64'),
      mimeType: 'image/png',
      // Pi ImageContent has no title field; page identity is carried by nearby text.
    })).filter((img, idx) => {
      if (Buffer.byteLength(img.data, 'base64') <= MAX_REHYDRATED_IMAGE_BYTES) return true;
      console.warn(`[Pi] rehydrate: skipped oversized rendered PDF page ${idx + 1} for ${label}`);
      return false;
    });
  } catch (err) {
    console.warn(`[Pi] rehydrate: PDF render failed for ${label}: ${(err as Error).message}`);
    return [];
  } finally {
    if (!existingTmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function mimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function describeAttachment(block: any): string {
  if (block.source && typeof block.source.path === 'string') return block.source.path;
  if (typeof block.title === 'string') return block.title;
  return 'unknown';
}
