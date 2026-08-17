import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const hub = fs.readFileSync(path.resolve(import.meta.dirname, './PersonalWorkHub.tsx'), 'utf8');
const timeline = fs.readFileSync(path.resolve(import.meta.dirname, './ChallengeTimelinePanel.tsx'), 'utf8');

describe('Legacy personal hub extraction', () => {
  it('presents todos as a note-like part of personal materials', () => {
    expect(hub).toContain('내 자료');
    expect(hub).toContain('나만 볼 수 있는 노트와 체크리스트입니다.');
    expect(hub).toContain('체크리스트');
    expect(hub).toContain('+ 새 노트');
    expect(hub).toContain('/api/personal-space/todos');
    expect(hub).toContain('/api/personal-space/files');
    expect(hub).not.toContain('승인·결재');
    expect(hub).not.toContain('pendingAssignedCount');
  });

  it('keeps personal materials out of the AI activity briefing', () => {
    expect(timeline).toContain('AI 팀 활동');
    expect(timeline).toContain('<AgentActivityTimeline projects={data.projects} selectedWorkstreamKey={selectedWorkstreamKey}');
    expect(timeline).toContain('<WorkstreamOverview challenge={selectedChallenge} onBack={returnToActivity} />');
    expect(timeline).not.toContain('<PersonalWorkHub');
    expect(timeline).not.toContain('<ApprovalInbox />');
    expect(timeline).not.toContain('<FileExchangeSurface');
  });

  it('loads personal files and todos independently with a retryable partial state', () => {
    expect(hub).toContain("readPersonalJson('/api/personal-space/files')");
    expect(hub).toContain("readPersonalJson('/api/personal-space/todos')");
    expect(hub).toContain('setItemsLoading(false)');
    expect(hub).toContain('setTodosLoading(false)');
    expect(hub).toContain('setItemsFailed(true)');
    expect(hub).toContain('setTodosFailed(true)');
    expect(hub).toContain('일부 개인 자료를 불러오지 못했습니다.');
    expect(hub).toContain('setLoadAttempt((attempt) => attempt + 1)');
  });

});
