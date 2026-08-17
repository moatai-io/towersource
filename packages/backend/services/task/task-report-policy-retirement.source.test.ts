import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const api = fs.readFileSync(path.resolve(import.meta.dirname, '../../routes/api.ts'), 'utf8');
const manager = fs.readFileSync(path.resolve(import.meta.dirname, 'task-manager.ts'), 'utf8');
const modal = fs.readFileSync(path.resolve(import.meta.dirname, '../../../frontend/src/components/kanban/NewTaskModal.tsx'), 'utf8');
const severity = fs.readFileSync(path.resolve(import.meta.dirname, '../tower/severity-router.ts'), 'utf8');

describe('retired task channel report policy', () => {
  it('allows only current policies through the task REST creation surface', () => {
    expect(api).toContain("const VALID_POLICIES = ['silent', 'notification'] as const");
    expect(api).not.toContain("const VALID_POLICIES = ['silent', 'channel'");
  });

  it('normalizes every new or edited policy to a current value at the service boundary', () => {
    expect(manager).toContain("reportPolicy === 'notification' ? 'notification' : 'silent'");
    expect(manager).toContain("updates.reportPolicy === 'notification' ? 'notification' : 'silent'");
  });

  it('offers Notification Hub rather than internal channels in the task UI', () => {
    expect(modal).toContain("{ id: 'notification', name: '🔔 알림으로 보고' }");
    expect(modal).toContain('완료 또는 실패 결과를 알림 센터에 남깁니다.');
    expect(modal).not.toContain('채널에만');
    expect(modal).not.toContain('연결된 채널');
  });

  it('keeps legacy policies readable as Notification severity only', () => {
    expect(severity).toContain("case 'notification':");
    expect(severity).toContain("case 'channel':");
    expect(severity).toContain('notifyInApp: true');
    expect(severity).not.toContain('channelPost:');
  });
});
