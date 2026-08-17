/**
 * pi-pdf-aware-read-tool.ts — safe read() fallback for PDFs.
 *
 * Owns: making the ordinary Pi read tool avoid treating PDFs as broken UTF-8.
 * For PDFs, it delegates to the same harness-level renderer behind pdf_view and
 * returns inline vision images from Tower internal cache. No project files are
 * created.
 */

import { Type } from '@sinclair/typebox';
import { createReadTool } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { renderPdfToCachedImages, pdfViewResultContent } from './pi-pdf-view-tool.js';
import { readCurrentSessionAttachmentImage } from './pi-session-attachment-tool.js';
import { sanitizeEmbeddedBinaryText } from '../services/content-safety/embedded-binary.js';
import { attachmentReferenceOnlyNotice } from '../services/content-safety/attachment-representation-policy.js';
import {
  prepareFileRepresentation,
  requireDetectedMime,
} from '../services/content-safety/file-representation-gateway.js';
import { applyModelOutputBudget } from '../services/content-safety/model-output-budget-gateway.js';

export interface PdfAwareReadContext {
  cwd: string;
  sessionId: string;
  userId?: number;
  userRole?: string;
  projectId?: string;
}


/**
 * Create a Pi read tool that automatically views PDFs as page images. Non-PDF
 * files delegate to the normal Pi read tool unchanged.
 */
export function createPdfAwareReadTool(ctx: PdfAwareReadContext): any {
  const originalRead = createReadTool(ctx.cwd);

  return {
    ...originalRead,
    description: `${originalRead.description} For PDF files, read automatically views representative pages as images for vision analysis; use pdf_view for explicit page ranges or higher DPI.`,
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

      const prepared = await prepareFileRepresentation(params.path, {
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        userId: ctx.userId,
      });
      const absPath = prepared.path;
      const representation = prepared.decision;
      if (representation.detectedMimeType !== 'application/pdf') {
        if (representation.modelMode === 'reference-only' || representation.modelMode === 'tool-required') {
          return {
            content: [{ type: 'text', text: attachmentReferenceOnlyNotice(prepared.name, representation) } as any],
            details: { attachmentRepresentation: representation },
          };
        }
        const result = await originalRead.execute(toolCallId, { ...params, path: absPath }, signal, onUpdate);
        return {
          ...result,
          details: { ...(result.details || {}), attachmentRepresentation: representation },
          content: Array.isArray(result.content)
            ? result.content.map((block: any) => block?.type === 'text' && typeof block.text === 'string'
              ? { ...block, text: sanitizeEmbeddedBinaryText(block.text) }
              : block)
            : result.content,
        };
      }

      try {
        requireDetectedMime(prepared, ['application/pdf'], 'read');
        const rendered = await renderPdfToCachedImages({
          cwd: ctx.cwd,
          path: absPath,
        });
        const budgeted = applyModelOutputBudget(await pdfViewResultContent(rendered));
        return {
          content: budgeted.content,
          details: {
            pdfAutoViewed: true,
            pageCount: rendered.pageCount,
            pages: rendered.pages,
            dpi: rendered.dpi,
            cacheHit: rendered.cacheHit,
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
