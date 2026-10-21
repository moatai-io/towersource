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

  it('localizes the active work title and agent labels', () => {
    expect(header).toContain("t('reference.titleLabel')");
    expect(header).toContain("t('reference.agentLabel')");
    expect(header).toContain('activeDisplayTitle');
    expect(header).toContain('activeAgentName');
  });

  it('derives the active work title from a file or session without restoring the removed copy action', () => {
    expect(header).toContain('const activeDisplayTitle = activeFileTab?.path');
    expect(header).toContain('? basename(activeFileTab.path)');
    expect(header).toContain(': activeSessionName');
    expect(header).not.toContain("navigator.clipboard.writeText(parts.join(' / '))");
  });
});
