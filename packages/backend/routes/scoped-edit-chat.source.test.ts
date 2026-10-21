import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './ws-handler.ts'), 'utf8');

describe('structured scoped-edit chat contract', () => {
  it('accepts source authority only from the structured frame field', () => {
    expect(source).toContain("sourceReference?: {");
    expect(source).toContain('validateTrustedSourceReference(data.sourceReference)');
    expect(source).not.toContain("data.message.includes('<tower_source_reference_json>')");
    expect(source).not.toContain('JSON.parse(data.message');
    expect(source).toContain('if (data.sourceReference && !structuredSourceReference)');
  });

  it('routes a valid source chip through the normal conversation engine as a visual reference', () => {
    expect(source).not.toContain('if (structuredSourceReference && !engine.isRunning(sessionId))');
    expect(source).toContain('buildSourceReferenceContext');
    expect(source).toContain('Treat this as a precise visual pointer and useful context, not as a required edit target or a write boundary.');
    expect(source).toContain('You may inspect the surrounding section or full current file');
    expect(source).toContain('finalMessage = `${buildSourceReferenceContext(structuredSourceReference)}');
    expect(source).toContain("if (engineName === 'pi' && typeof engine.steer === 'function')");
    expect(source).toContain('const steeredMessage = structuredSourceReference');
    expect(source).toContain('sourceReference: structuredSourceReference');
  });

  it('uses conditional Worker writes and still requires confirmation for risky or multi-file changes', () => {
    expect(source).toContain('compareAndSwapProjectWorkspaceText');
    expect(source).toContain('expectedContent');
    expect(source).toContain('const changedWarnings = plan.warnings.filter');
    expect(source).toContain('if (changedWarnings.length > 0)');
    expect(source).not.toContain("if (plan.mode === 'confirmation-required')");
    expect(source).toContain('changedPaths.length > 1');
    expect(source).toContain('createMultiFileEditProposal');
    expect(source).toContain('multiFileProposal: proposal');
    expect(source).toContain('아직 파일은 변경하지 않았습니다');
  });

  it('locks and rereads host files before same-file range application', () => {
    expect(source).toContain('lockfile.lock(writePath');
    expect(source).toContain('const lockedContent = readAuthorizedProjectText(writePath)');
    expect(source.indexOf('const lockedContent = readAuthorizedProjectText(writePath)'))
      .toBeLessThan(source.indexOf('applyApprovedRanges(lockedContent'));
  });
});
