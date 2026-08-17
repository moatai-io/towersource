import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const modal = fs.readFileSync(path.join(import.meta.dirname, 'AgentCredentialsModal.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.join(import.meta.dirname, 'Sidebar.tsx'), 'utf8');
const connections = fs.readFileSync(path.join(import.meta.dirname, 'AgentConnectionsPanel.tsx'), 'utf8');

describe('Agent Credential independent management surface', () => {
  it('opens from a dedicated Agent menu item rather than Project settings', () => {
    expect(sidebar).toContain('Credential 관리');
    expect(sidebar).toContain('setShowCredentials(true)');
    const settings = sidebar.slice(sidebar.indexOf('function ProjectSettingsPanel'));
    expect(settings).not.toContain('<AgentConnectionsPanel');
  });

  it('uses a wide responsive dialog with Organization Connections and direct Agent Credential creation', () => {
    expect(modal).toContain('max-w-7xl');
    expect(modal).toContain('h-[min(92dvh,980px)]');
    expect(modal).toContain('<AgentConnectionsPanel projectId={project.id} spacious />');
    expect(modal).toContain('새 전용 Credential 추가');
    expect(modal).toContain('/credentials/api-key`');
    expect(modal).toContain("scope: 'project'");
  });

  it('lists Agent-owned credentials and supports update, inspect, and Admin-only raw reveal', () => {
    expect(modal).toContain('/projects/${encodeURIComponent(project.id)}/credentials`');
    expect(modal).toContain('/credentials/${encodeURIComponent(editing.id)}/rotate`');
    expect(modal).toContain('/credentials/${encodeURIComponent(credential.id)}/inspect`');
    expect(modal).toContain('원문 보기');
    expect(modal).toContain('수정하기');
    expect(modal).toContain('재인증');
    expect(modal).toContain('구조 보기');
    expect(modal).toContain("const isAdmin = getCurrentRole() === 'admin'");
    expect(modal).toContain('30초 후 자동 마스킹');
  });

  it('keeps secrets out of files/chat and supports keyboard dismissal', () => {
    expect(modal).toContain('값은 채팅이나 프로젝트 파일에 저장되지 않습니다.');
    expect(modal).toContain("event.key === 'Escape'");
    expect(modal).toContain('role="dialog"');
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toContain('focus-visible:ring-2');
    expect(modal).not.toContain('opacity-');
    expect(modal).not.toMatch(/(?:text|bg|border)-(?:gray|slate)-/);
  });

  it('offers a spacious Connection layout without changing compact reuse', () => {
    expect(connections).toContain('spacious = false');
    expect(connections).toContain("spacious ? 'grid gap-3 sm:grid-cols-2' : 'space-y-2'");
  });
});
