import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const inbox = fs.readFileSync(path.resolve(import.meta.dirname, './ApprovalInbox.tsx'), 'utf8');
const app = fs.readFileSync(path.resolve(import.meta.dirname, '../../App.tsx'), 'utf8');

describe('Approval to Viewer and AI Service journey', () => {
  it('opens evidence in Viewer and keeps approval separate from deployment', () => {
    expect(inbox).toContain("split: 'right'");
    expect(inbox).toContain('Viewer에서 근거 확인');
    expect(inbox).toContain('승인은 배포 실행과 별개입니다');
  });

  it('routes an approved result to the independent AI Service workspace', () => {
    expect(inbox).toContain("new CustomEvent('tower-open-ai-services'");
    expect(inbox).toContain('AI 서비스로 이동');
    expect(app).toContain("window.addEventListener('tower-open-ai-services'");
    expect(app).toContain("setActiveView('aiServices')");
  });
});
