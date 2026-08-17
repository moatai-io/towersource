import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const attachmentTool = readFileSync(new URL('./pi-session-attachment-tool.ts', import.meta.url), 'utf8');
const readTool = readFileSync(new URL('./pi-pdf-aware-read-tool.ts', import.meta.url), 'utf8');
const gateway = readFileSync(new URL('../services/content-safety/file-representation-gateway.ts', import.meta.url), 'utf8');

describe('Pi session attachment image reading', () => {
  it('delegates session authority, magic detection, and byte budgets to the shared gateway', () => {
    expect(attachmentTool).toContain('prepareFileRepresentation(uri');
    expect(attachmentTool).toContain('readPreparedVisionImage(prepared)');
    expect(attachmentTool).not.toContain('data.toString(\'base64\')');
    expect(gateway).toContain('resolveSessionAttachment(ctx.userId, ctx.sessionId, source)');
    expect(gateway).toContain('decideAttachmentRepresentation({ name, bytes: probe })');
    expect(gateway).toContain('prepared.sizeBytes > maxBytes');
  });

  it('returns session images inline instead of passing their host path to the project-scoped read tool', () => {
    expect(readTool).toContain('readCurrentSessionAttachmentImage(ctx, params.path)');
    expect(readTool).toContain('content: [image.content]');
    expect(readTool).toContain('sessionAttachment: true');
  });

  it('also makes the explicit resolver useful for direct image inspection', () => {
    expect(attachmentTool).toContain('inlineImage: true');
    expect(attachmentTool).toContain('image.content');
    expect(attachmentTool).toContain('classification: prepared.decision.classification');
  });
});
