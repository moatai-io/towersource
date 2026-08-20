import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const header = fs.readFileSync(path.resolve(__dirname, 'Header.tsx'), 'utf8');
const selector = fs.readFileSync(path.resolve(__dirname, 'ModelSelector.tsx'), 'utf8');

describe('header and model selector locale contract', () => {
  it('uses one localized fallback for lossy engine-switch failures', () => {
    expect(header).toContain("result.error?.message ?? t('engineSwitchFailed')");
    expect(selector).toContain("result.error?.message ?? t('engineSwitchFailed')");
    expect(header).toContain('confirmEngineSwitch(');
    expect(selector).toContain('confirmEngineSwitch(');
  });

  it('localizes file and conversation reference payloads and copy results', () => {
    expect(header).toContain("activeFileTab?.path ? 'file' : 'session'");
    expect(header).toContain("t('reference.workspace', { name: activeProjectName })");
    expect(header).toContain("t(`reference.${activeDisplayKind}`, { title: activeDisplayTitle })");
    expect(header).toContain("t(`reference.${activeDisplayKind}Copied`)");
    expect(header).toContain("t('reference.copyFailed')");
  });

  it('preserves clipboard payload structure and stable IDs', () => {
    expect(header).toContain("navigator.clipboard.writeText(parts.join(' / '))");
    expect(header).toContain('activeDisplayId ? `id: ${activeDisplayId}` : null');
  });
});
