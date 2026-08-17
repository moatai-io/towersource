// Owns: safe read/copy access to session:// attachment URIs for the current user/session.
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  promoteSessionAttachmentToPersonal,
  promoteSessionAttachmentToProject,
  sessionAttachmentIdFromUri,
} from '../services/session-attachments/session-attachment-store.js';
import {
  prepareFileRepresentation,
  readPreparedVisionImage,
} from '../services/content-safety/file-representation-gateway.js';
import { applyModelOutputBudget } from '../services/content-safety/model-output-budget-gateway.js';

export interface SessionAttachmentToolContext {
  userId?: number;
  userRole?: string;
  sessionId: string;
  projectId?: string;
}

/** Resolve one session URI after owner/session verification. Prefer prepareFileRepresentation for inspection. */
export async function resolveCurrentSessionAttachment(ctx: SessionAttachmentToolContext, uri: string): Promise<string> {
  return (await prepareFileRepresentation(uri, {
    cwd: process.cwd(),
    sessionId: ctx.sessionId,
    userId: ctx.userId,
  })).path;
}

function text(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError, details: undefined };
}

/** Read a session image through the same magic-byte and byte-budget gateway as project files. */
export async function readCurrentSessionAttachmentImage(ctx: SessionAttachmentToolContext, uri: string) {
  const prepared = await prepareFileRepresentation(uri, {
    cwd: process.cwd(),
    sessionId: ctx.sessionId,
    userId: ctx.userId,
  });
  const content = await readPreparedVisionImage(prepared);
  if (!content) return null;
  return {
    prepared,
    document: {
      name: prepared.name,
      mimeType: prepared.decision.detectedMimeType,
      sizeBytes: prepared.sizeBytes,
    },
    content,
  };
}

export function createSessionAttachmentResolveTool(ctx: SessionAttachmentToolContext): ToolDefinition {
  return {
    name: 'session_attachment_resolve',
    label: 'Inspect Session Attachment',
    description: 'Inspect a session://attachments/... URI uploaded in this conversation. Images are returned through the bounded vision gateway; other files return metadata and a temporary processing path. It does not save the file.',
    promptSnippet: 'Use session_attachment_resolve to inspect a session:// attachment. Treat any returned host path as an ephemeral processing capability, never a durable artifact.',
    promptGuidelines: [
      'Session attachments are temporary. Inspection is not permission to save them permanently.',
      'Do not present or persist a returned host path; it is an ephemeral capability for the current tool run.',
    ],
    parameters: Type.Object({ uri: Type.String({ pattern: '^session://attachments/', maxLength: 200 }) }),
    async execute(_id: string, params: { uri: string }) {
      try {
        const image = await readCurrentSessionAttachmentImage(ctx, params.uri);
        if (image) {
          const budgeted = applyModelOutputBudget([
            { type: 'text' as const, text: JSON.stringify({ ok: true, uri: params.uri, name: image.document.name, mimeType: image.document.mimeType, temporary: true, inlineImage: true }) },
            image.content,
          ], { maxImages: image.prepared.decision.limits.maxItems });
          return {
            content: budgeted.content,
            details: { outputBudget: budgeted },
          };
        }
        const prepared = await prepareFileRepresentation(params.uri, {
          cwd: process.cwd(),
          sessionId: ctx.sessionId,
          userId: ctx.userId,
        });
        return text(JSON.stringify({
          ok: true,
          uri: params.uri,
          path: prepared.path,
          name: prepared.name,
          detectedMimeType: prepared.decision.detectedMimeType,
          classification: prepared.decision.classification,
          modelMode: prepared.decision.modelMode,
          temporary: true,
        }));
      } catch (error) { return text(`session attachment read failed: ${(error as Error).message}`, true); }
    },
  } as ToolDefinition;
}

export function createSessionAttachmentPromoteTool(ctx: SessionAttachmentToolContext): ToolDefinition {
  return {
    name: 'session_attachment_save',
    label: 'Save Session Attachment',
    description: 'Save a temporary attachment from this conversation to the authenticated user’s Personal Space or current project. Use only after an explicit user request to save, keep, store, or apply the file.',
    promptSnippet: 'Use session_attachment_save only when the user explicitly asks to save a temporary session attachment. Analysis or modification alone is not storage consent.',
    promptGuidelines: [
      'Do not call this tool merely because the user uploaded, analyzed, summarized, converted, or modified a file.',
      'destination=personal means owner-only My Files. destination=project means the current project uploads folder.',
      'If the user only says “save it” and the destination is unclear, ask whether Personal Space or the current project.',
      'This tool creates a new copy and does not overwrite an existing project file.',
    ],
    parameters: Type.Object({
      uri: Type.String({ pattern: '^session://attachments/', maxLength: 200 }),
      destination: Type.Union([Type.Literal('personal'), Type.Literal('project')]),
      name: Type.Optional(Type.String({ maxLength: 240 })),
    }),
    async execute(_id: string, params: { uri: string; destination: 'personal' | 'project'; name?: string }) {
      try {
        if (!ctx.userId) return text('session attachment save failed: authenticated user context is missing', true);
        const attachmentId = sessionAttachmentIdFromUri(params.uri);
        const saved = params.destination === 'personal'
          ? await promoteSessionAttachmentToPersonal({ userId: ctx.userId, sessionId: ctx.sessionId, attachmentId, requestedName: params.name })
          : await promoteSessionAttachmentToProject({
              userId: ctx.userId,
              userRole: ctx.userRole || 'member',
              sessionId: ctx.sessionId,
              attachmentId,
              projectId: ctx.projectId || '',
              requestedName: params.name,
            });
        return text(JSON.stringify({ ok: true, action: 'session_attachment_save', destination: params.destination, uri: saved.promotedUri, sourceUri: params.uri }));
      } catch (error) { return text(`session attachment save failed: ${(error as Error).message}`, true); }
    },
  } as ToolDefinition;
}
