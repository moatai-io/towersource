import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './SidebarSessionTimeline.tsx'), 'utf8');

describe('Sidebar Session timeline presentation boundary', () => {
  it('날짜 header와 Project run markup을 소유한다', () => {
    expect(source).toContain('data-new-date-group={run.dateKey}');
    expect(source).toContain('data-new-agent-run={run.project.id}');
    expect(source).toContain('run.project.agent?.displayName || run.project.name');
    expect(source).toContain('sidebar-timeline-project');
    expect(source).toContain('border-l border-surface-700/25');
    expect(source).not.toContain('sidebar-timeline-date sticky');
  });

  it('Session interaction을 전달받은 callback으로만 위임한다', () => {
    expect(source).toContain('onDelete={onDismissSession}');
    expect(source).toContain('onRename={onRenameSession}');
    expect(source).toContain('onToggleFavorite={onToggleFavorite}');
    expect(source).toContain('onMoveToProject={onMoveSession}');
    expect(source).not.toContain('useSessionStore');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('localStorage');
  });

  it('최근 목록 전용 숨김 표현을 유지한다', () => {
    expect(source).toContain('deleteActionLabel={hideFromLatestLabel}');
    expect(source).toContain('deleteActionIcon="down"');
    expect(source).toContain('recentInbox');
  });
});
