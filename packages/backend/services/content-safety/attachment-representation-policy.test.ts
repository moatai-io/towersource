import { describe, expect, it } from 'vitest';
import { attachmentReferenceOnlyNotice, decideAttachmentRepresentation } from './attachment-representation-policy.js';

describe('AttachmentRepresentationPolicy', () => {
  it('uses image magic rather than a misleading text extension', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1024)]);
    const decision = decideAttachmentRepresentation({ name: 'photo.txt', bytes });
    expect(decision).toMatchObject({ classification: 'image', modelMode: 'vision', detectedMimeType: 'image/jpeg' });
    expect(decision.limits.maxItems).toBe(4);
  });

  it('keeps ordinary Markdown bounded instead of automatically inlining without a budget', () => {
    const decision = decideAttachmentRepresentation({ name: 'notes.md', bytes: Buffer.from('# Notes\n\nhello') });
    expect(decision).toMatchObject({ classification: 'text', modelMode: 'bounded-text' });
    expect(decision.limits.maxChars).toBe(50 * 1024);
  });

  it('downgrades a Markdown base64 bomb to reference-only', () => {
    const bytes = Buffer.from(`# Notes\n\n${'Q'.repeat(15 * 1024)}`);
    const decision = decideAttachmentRepresentation({ name: 'notes.md', bytes });
    expect(decision).toMatchObject({ classification: 'opaque', modelMode: 'reference-only' });
    expect(attachmentReferenceOnlyNotice('notes.md', decision)).not.toContain('QQQQQQ');
  });

  it('detects a ZIP renamed to txt', () => {
    const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
    expect(decideAttachmentRepresentation({ name: 'payload.txt', bytes })).toMatchObject({
      classification: 'archive',
      modelMode: 'tool-required',
      detectedMimeType: 'application/zip',
    });
  });

  it('routes PPTX containers to a dedicated document tool', () => {
    const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
    expect(decideAttachmentRepresentation({ name: 'one-slide.pptx', bytes })).toMatchObject({
      classification: 'document',
      modelMode: 'tool-required',
    });
  });

  it('routes PDFs to bounded visual or extraction tools', () => {
    const bytes = Buffer.from('%PDF-1.7\n% fixture');
    expect(decideAttachmentRepresentation({ name: 'broken.pdf', bytes })).toMatchObject({
      classification: 'document',
      modelMode: 'tool-required',
      detectedMimeType: 'application/pdf',
    });
  });

  it('fails safe on NUL-containing pseudo text', () => {
    expect(decideAttachmentRepresentation({ name: 'binary.md', bytes: Buffer.from([0x61, 0, 0x62]) })).toMatchObject({
      classification: 'opaque',
      modelMode: 'reference-only',
    });
  });
});
