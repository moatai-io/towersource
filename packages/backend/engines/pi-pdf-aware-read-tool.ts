/**
 * pi-pdf-aware-read-tool.ts — safe read() fallback for PDFs.
 *
 * Owns: making the ordinary Pi read tool avoid treating PDFs as broken UTF-8.
 * For PDFs, it delegates to the same harness-level renderer behind pdf_view and
 * returns inline vision images from Tower internal cache. No project files are
 * created.
 */

import { readWorkerImage } from './pi-worker-image-read.js';
import path from 'node:path';
import { Type } from '@sinclair/typebox';
import { createReadTool } from '@earendil-works/pi-coding-agent';
import type { ReadOperations } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { renderPdfToCachedImages, pdfViewResultContent } from './pi-pdf-view-tool.js';
import { readCurrentSessionAttachmentImage } from './pi-session-attachment-tool.js';
import { sanitizeEmbeddedBinaryText } from '../services/content-safety/embedded-binary.js';
import { attachmentReferenceOnlyNotice } from '../services/content-safety/attachment-representation-policy.js';
import {
  prepareFileRepresentation,
  readPreparedVisionImage,
  readPreparedFileBytes,
  requireDetectedMime,
  withPreparedLocalFile,
  type FileRepresentationSource,
} from '../services/content-safety/file-representation-gateway.js';
import { preparePdfVisualBatch } from './pi/pdf-visual-batch.js';
import { applyModelOutputBudget } from '../services/content-safety/model-output-budget-gateway.js';

export interface PdfAwareReadContext {
  cwd: string;
  sessionId: string;
  userId?: number;
  userRole?: string;
  projectId?: string;
  projectRoot?: string;
  /** Already-authorized Project file source. Never inferred from a Worker heartbeat or legacy file binding. */
  projectSource?: FileRepresentationSource;
}


/**
 * Create a Pi read tool that automatically views PDFs as page images. Non-PDF
 * files delegate to the normal Pi read tool unchanged.
 */
export function createPdfAwareReadTool(ctx: PdfAwareReadContext): any {
  const maxReadBytes = 50 * 1024 * 1024;
  if (ctx.projectSource && !ctx.projectRoot) throw new Error('PROJECT_READ_SOURCE_ROOT_REQUIRED');
  const authorizedPath = (source: string): string => {
    const root = path.resolve(ctx.projectRoot!);
    const target = path.resolve(source);
    if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new Error('PROJECT_FILE_SOURCE_OUTSIDE_ROOT');
    return target;
  };
  const operations: ReadOperations | undefined = ctx.projectSource ? {
    async access(source) {
      const result = await ctx.projectSource!.stat(authorizedPath(source));
      if (!result.isFile()) throw new Error('PROJECT_READ_NOT_FILE');
    },
    async readFile(source) {
      return ctx.projectSource!.readFile(authorizedPath(source), maxReadBytes);
    },
  } : undefined;
  const originalRead = createReadTool(ctx.cwd, operations ? { operations } : undefined);

  return {
    ...originalRead,
    description: `${originalRead.description} Authorized session://attachments/ URIs are supported without saving the original to the Project. For PDF files, read automatically views representative pages as images for vision analysis; use pdf_view for explicit page ranges or higher DPI.`,
    promptGuidelines: [
      ...(Array.isArray((originalRead as any).promptGuidelines) ? (originalRead as any).promptGuidelines : []),
      'PDFs are visual documents: inspect rendered page images with vision before concluding from text extraction alone.',
      'For detailed PDF reading and pdf_view/pdf_read selection rules, use runtime_guide_read with name="pdf-analysis".',
    ],
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to read (relative or absolute)' }),
      offset: Type.Optional(Type.Number({ description: 'Line number to start reading from (1-indexed). Ignored for PDF visual read.' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read. Ignored for PDF visual read.' })),
    }),
    async execute(toolCallId: string, params: { path: string; offset?: number; limit?: number }, signal: AbortSignal | undefined, onUpdate: any): Promise<AgentToolResult<any>> {
      const isSessionAttachment = params.path.startsWith('session://attachments/');
      if (isSessionAttachment) {
        try {
          const image = await readCurrentSessionAttachmentImage(ctx, params.path);
          if (image) {
            return {
              content: [image.content],
              details: {
                sessionAttachment: true,
                name: image.document.name,
                mimeType: image.document.mimeType,
                sizeBytes: image.document.sizeBytes,
              },
            };
          }
        } catch (error) {
          return {
            content: [{ type: 'text', text: `[Session attachment read failed] ${(error as Error).message}` } as any],
            details: { sessionAttachment: true, error: (error as Error).message },
            isError: true,
          } as any;
        }
      }

      if (!ctx.projectSource) {
        const workerImage = await readWorkerImage(params.path, ctx);
        if (workerImage) return workerImage;
      }

      const prepared = await prepareFileRepresentation(params.path, {
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        userId: ctx.userId,
        ...(ctx.projectSource ? { projectRoot: ctx.projectRoot, projectSource: ctx.projectSource } : {}),
      });
      const absPath = prepared.path;
      const representation = prepared.decision;
      if (representation.detectedMimeType !== 'application/pdf') {
        if (representation.modelMode === 'vision' && representation.detectedMimeType?.startsWith('image/')) {
          const image = await readPreparedVisionImage(prepared, ctx.projectSource);
          if (image) return { content: [image], details: { attachmentRepresentation: representation, projectStaged: Boolean(ctx.projectSource) } };
        }
        if (ctx.projectSource && !prepared.temporary && representation.modelMode !== 'bounded-text') {
          return { content: [{ type: 'text', text: '[Project file requires a format-specific authorized reader]' } as any], isError: true } as any;
        }
        if (representation.modelMode === 'reference-only' || representation.modelMode === 'tool-required') {
          return {
            content: [{ type: 'text', text: attachmentReferenceOnlyNotice(prepared.name, representation) } as any],
            details: { attachmentRepresentation: representation },
          };
        }
        const reader = prepared.temporary ? createReadTool(ctx.cwd, { operations: {
          readFile: async input => {
            if (input !== prepared.path) throw new Error('SESSION_ATTACHMENT_SOURCE_CHANGED');
            return readPreparedFileBytes(prepared, undefined, 8 * 1024 * 1024);
          },
          access: async input => { if (input !== prepared.path) throw new Error('SESSION_ATTACHMENT_SOURCE_CHANGED'); },
          detectImageMimeType: async () => null,
        } }) : originalRead;
        const result = await reader.execute(toolCallId, { ...params, path: absPath }, signal, onUpdate);
        return {
          ...result,
          details: { ...(result.details || {}), attachmentRepresentation: representation },
          content: Array.isArray(result.content)
            ? result.content.map((block: any) => block?.type === 'text' && typeof block.text === 'string'
              ? { ...block, text: sanitizeEmbeddedBinaryText(prepared.temporary ? block.text.split(prepared.path).join(prepared.source) : block.text) }
              : block)
            : result.content,
        };
      }

      try {
        requireDetectedMime(prepared, ['application/pdf'], 'read');
        const rendered = await withPreparedLocalFile(prepared, ctx.projectSource, 100 * 1024 * 1024, async (localPath, metadata) => {
          const result = await renderPdfToCachedImages({
            cwd: ctx.cwd,
            path: localPath,
            pages: 'all',
            modelBatch: true,
            cacheIdentity: metadata.sha256 ? `${prepared.temporary ? prepared.source : absPath}:${metadata.sha256}` : undefined,
          });
          return { ...result, pdfPath: isSessionAttachment ? params.path : absPath };
        });
        const batch = await preparePdfVisualBatch(rendered);
        const content = await pdfViewResultContent(batch.rendered);
        content.push({ type: 'text', text: batch.notice });
        const budgeted = applyModelOutputBudget(content);
        return {
          content: budgeted.content,
          ...(batch.reference.pages.length === 0 ? { isError: true } : {}),
          details: {
            pdfAutoViewed: batch.reference.pages.length > 0,
            visualReference: batch.reference,
            coverage: batch.coverage,
            pageCount: rendered.pageCount,
            pages: batch.coverage.deliveredPages,
            dpi: rendered.dpi,
            cacheHit: rendered.cacheHit,
            projectStaged: Boolean(ctx.projectSource),
            outputBudget: budgeted,
          },
        };
      } catch (error) {
        const message = (error as Error).message;
        return {
          content: [{
            type: 'text',
            text: `[PDF visual read failed] ${message}\nUse pdf_view with an explicit page range, or pdf_read as a text/table-only fallback if the PDF has a text layer.`,
          } as any],
          details: { pdfAutoViewed: false, error: message },
          isError: true,
        } as any;
      }
    },
  };
}
