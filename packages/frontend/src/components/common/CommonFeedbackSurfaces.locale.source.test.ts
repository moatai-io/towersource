import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, relative), 'utf8');
const confirm = read('ConfirmDialog.tsx');
const upload = read('UploadProgressChip.tsx');
const running = read('RunIndicator.tsx');
const panel = read('../whatsnew/WhatsNewPanel.tsx');
const modal = read('../onboarding/WhatsNewModal.tsx');
const skill = read('../chat/SkillInvocationChip.tsx');
const branch = read('../chat/ConversationBranchProvenance.tsx');

describe('common feedback surfaces locale contract', () => {
  it('localizes default confirmation, upload, and running labels without changing explicit overrides', () => {
    expect(confirm).toContain("confirmLabel ?? t('confirm')");
    expect(confirm).toContain("cancelLabel ?? t('cancel')");
    expect(upload).toContain("t('uploadProgress.label'");
    expect(running).toContain("label === undefined ? t('running') : label");
  });

  it("localizes What's New chrome while preserving changelog markdown as source data", () => {
    expect(panel).toContain("t('whatsNew.title')");
    expect(panel).toContain("t('whatsNew.empty')");
    expect(panel).toContain('{entry.raw}');
    expect(modal).toContain("t('getStarted')");
  });

  it('localizes skill invocation and branch provenance while preserving source navigation', () => {
    expect(skill).toContain("t('skillInvocation.applied'");
    expect(branch).toContain("t('branch.openPoint'");
    expect(branch).toContain("new CustomEvent('kanban-select-session'");
    expect(branch).toContain('/branch-source');
  });
});
