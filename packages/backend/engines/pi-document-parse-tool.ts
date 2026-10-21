// Owns: document_parse, authorized Project/session sources and Project-scoped Markdown output.
// Public API: createDocumentParseTool.

import fs from 'fs/promises';
import path from 'path';
import { assertSessionAllowsSharedArtifactWrite } from '../services/session/session-artifact-privacy.js';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { resolveProjectWorkspaceFile, writeProjectWorkspaceText } from '../services/project-environment/project-workspace-files.js';
import { prepareFileRepresentation, readPreparedFileBytes, type FileRepresentationSource } from '../services/content-safety/file-representation-gateway.js';
import { resolveProjectApiKeySecretValue } from '../services/credential-vault/credential-vault-service.js';

const DEFAULT_COREPIN_GATEWAY_BASE_URL = 'https://tower-provisioning-main-eef9b31.zuplo.app/corepin';
const MAX_SYNC_FILE_BYTES = 100 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([
  '.hwp', '.hwpx', '.hwpml', '.doc', '.docx', '.pptx', '.xls', '.xlsx', '.pdf',
  '.jpg', '.jpeg', '.png', '.heic', '.tif', '.tiff', '.webp', '.bmp', '.html',
  '.htm', '.epub', '.rtf', '.csv', '.tsv', '.md', '.txt',
]);

export interface DocumentParseToolContext {
  cwd: string;
  sessionId?: string;
  projectSource?: FileRepresentationSource;
  projectRoot?: string;
  projectId?: string;
  userId?: number;
}

const DocumentParseParams = Type.Object({
  path: Type.String({ description: 'Project-local source or session://attachments/ URI. Supported: HWP/HWPX/PDF/DOC(X)/PPTX/XLS(X)/images/HTML/text.' }),
  output_path: Type.Optional(Type.String({ description: 'Project-relative Markdown output path. Defaults to <source-name>.md beside the source.' })),
});

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveProjectPath(raw: string, root: string, cwd: string): string {
  const mapped = raw === '/workspace'
    ? root
    : raw.startsWith('/workspace/')
      ? path.join(root, raw.slice('/workspace/'.length))
      : path.isAbsolute(raw)
        ? raw
        : path.resolve(cwd, raw);
  const resolved = path.resolve(mapped);
  if (!isInside(root, resolved)) throw new Error('document_parse only accepts paths inside the current Project.');
  return resolved;
}

function defaultOutputPath(sourcePath: string): string {
  const parsed = path.parse(sourcePath);
  return path.join(parsed.dir, `${parsed.name}.md`);
}

async function resolveGatewayCredential(ctx: DocumentParseToolContext): Promise<{ baseUrl: string; apiKey: string }> {
  const envKey = process.env.ZUPLO_VIRTUAL_KEY?.trim();
  if (envKey) {
    return {
      baseUrl: (process.env.COREPIN_API_BASE_URL || DEFAULT_COREPIN_GATEWAY_BASE_URL).replace(/\/$/, ''),
      apiKey: envKey,
    };
  }
  if (!ctx.projectId || !ctx.userId) throw new Error('Corepin gateway Credential is not available for this Project.');
  const resolved = await resolveProjectApiKeySecretValue({
    projectId: ctx.projectId,
    userId: ctx.userId,
    envName: 'ZUPLO_VIRTUAL_KEY',
    targetType: 'corepin-document-parse',
  });
  if (!resolved?.value) throw new Error('Corepin gateway Credential is not configured for this Project.');
  return {
    baseUrl: (process.env.COREPIN_API_BASE_URL || DEFAULT_COREPIN_GATEWAY_BASE_URL).replace(/\/$/, ''),
    apiKey: resolved.value,
  };
}

function boundedError(status: number, payload: any): string {
  const code = payload?.error?.code || payload?.code || 'upstream_error';
  const requestId = payload?.error?.request_id || payload?.request_id || 'unknown';
  return `Corepin parse failed: HTTP ${status}, code=${code}, request_id=${requestId}`;
}

export function createDocumentParseTool(ctx: DocumentParseToolContext): ToolDefinition {
  return {
    name: 'document_parse',
    label: 'Parse Document to Markdown',
    description: [
      'Parse a Project document or authorized session:// attachment into Project Markdown through the shared Corepin API gateway.',
      'Use the original attachment URI; do not permanently store the source merely to analyze it.',
      'Supports Korean HWP/HWPX plus PDF, DOCX, PPTX, XLSX, images, HTML, EPUB, RTF, CSV/TSV, Markdown, and text.',
      'The source document is sent to the external Corepin service. The result is saved inside the current Project and the document body is not returned in tool output.',
    ].join(' '),
    promptSnippet: 'Convert a Project document such as HWP/HWPX/PDF/DOCX/PPTX/XLSX/image into a Markdown file with document_parse.',
    promptGuidelines: [
      'Use document_parse when the user wants a general document converted to Markdown, especially HWP/HWPX or Korean OCR documents.',
      'The source file is transmitted to Corepin. Use it only for a user-requested document conversion; do not upload unrelated files.',
      'For PDF visual/layout understanding use pdf_view, and for spreadsheet formulas/formatting analysis use excel_read instead.',
      'The default synchronous path accepts files up to 100MB. Large documents need a separate async workflow.',
    ],
    parameters: DocumentParseParams,
    async execute(_toolCallId: string, params: { path: string; output_path?: string }) {
      try {
        // Output is Project Markdown, not private-session storage. Deny before provider upload.
        await assertSessionAllowsSharedArtifactWrite(ctx.sessionId);
        const projectRoot = path.resolve(ctx.projectRoot || ctx.cwd);
        const attachment = params.path.startsWith('session://attachments/');
        const prepared = attachment || ctx.projectSource ? await prepareFileRepresentation(params.path, {
          cwd: ctx.cwd, sessionId: ctx.sessionId, userId: ctx.userId, projectRoot,
          projectSource: ctx.projectSource,
        }) : undefined;
        const sourcePath = prepared?.path || resolveProjectPath(params.path, projectRoot, ctx.cwd);
        const sourceStat = prepared ? { size: prepared.sizeBytes, isFile: () => true } : await fs.stat(sourcePath);
        if (!sourceStat.isFile()) throw new Error('Source path is not a file.');
        if (sourceStat.size > MAX_SYNC_FILE_BYTES) throw new Error('Source document is too large for synchronous parsing (100MB limit).');

        const extension = path.extname(sourcePath).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(extension)) throw new Error(`Unsupported document extension: ${extension || '(none)'}`);

        const outputPath = resolveProjectPath(params.output_path || (attachment ? path.join('work', path.basename(defaultOutputPath(sourcePath))) : defaultOutputPath(sourcePath)), projectRoot, ctx.cwd);
        if (path.extname(outputPath).toLowerCase() !== '.md') throw new Error('output_path must end with .md.');
        if (outputPath === sourcePath) throw new Error('Output path must differ from the source path.');

        const connection = await resolveGatewayCredential(ctx);
        const bytes = prepared ? await readPreparedFileBytes(prepared, ctx.projectSource, MAX_SYNC_FILE_BYTES)
          : await fs.readFile(sourcePath);
        const form = new FormData();
        form.set('file', new Blob([new Uint8Array(bytes)]), path.basename(sourcePath));
        form.set('output_format', 'markdown');
        form.set('ocr_fallback', 'true');

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120_000);
        let response: Response;
        try {
          response = await fetch(`${connection.baseUrl}/v1/doc/parse`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${connection.apiKey}`,
              'User-Agent': 'Tower-Document-Parse/1.0',
            },
            body: form,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }

        const payload = await response.json().catch(() => ({} as any));
        if (!response.ok) throw new Error(boundedError(response.status, payload));
        if (typeof payload.markdown !== 'string') throw new Error('Corepin response did not include Markdown output.');

        if (ctx.projectId && ctx.userId) {
          const reference = await resolveProjectWorkspaceFile({ projectId: ctx.projectId, projectRoot,
            relativePath: path.relative(projectRoot, outputPath).split(path.sep).join('/') });
          await writeProjectWorkspaceText({ reference, actorUserId: ctx.userId, content: payload.markdown, exclusive: true });
        } else {
          throw new Error('Document output requires current Project and user authority.');
        }
        const meta = payload.meta || {};
        const relativeOutput = path.relative(projectRoot, outputPath) || path.basename(outputPath);
        return {
          content: [{
            type: 'text',
            text: [
              `Document parsed to Markdown: ${relativeOutput}`,
              `Source format: ${meta.file_format || extension.slice(1) || 'unknown'}`,
              `Pages: ${meta.page_count ?? 'unknown'}; OCR pages: ${meta.ocr_pages_used ?? 0}`,
              `Model: ${meta.model_id || 'doc'} ${meta.model_version || ''}`.trim(),
              `Request ID: ${meta.request_id || 'unknown'}`,
              Array.isArray(meta.warnings) && meta.warnings.length ? `Warnings: ${meta.warnings.join('; ')}` : 'Warnings: none',
            ].join('\n'),
          }],
          details: {
            parsed: true,
            sourcePath: attachment ? params.path : sourcePath,
            outputPath,
            relativeOutput,
            pageCount: meta.page_count,
            fileFormat: meta.file_format,
            ocrPagesUsed: meta.ocr_pages_used,
            modelId: meta.model_id,
            modelVersion: meta.model_version,
            requestId: meta.request_id,
            warnings: meta.warnings || [],
          },
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `[document_parse error] ${(error as Error).message}` }],
          details: { parsed: false, error: (error as Error).message },
          isError: true,
        } as any;
      }
    },
  } as ToolDefinition;
}
