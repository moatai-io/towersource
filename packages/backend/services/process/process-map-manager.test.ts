import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/pg-repo.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query } from '../../db/pg-repo.js';
import { getAutomationRunProcessMap, getSessionProcessMap, type Automation } from './process-map-manager.js';
import type { AutomationRun } from '../task/automation-manager.js';

function assistantToolContent(name: string, input: any): string {
  return JSON.stringify([{ type: 'tool_use', id: 'toolu_1', name, input }]);
}

describe('process-map-manager command and skill invocation projection', () => {
  it('prefers latest ProcessMapWrite tool state for chat session maps', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      {
        id: 'm-pmw',
        created_at: '2026-06-30T00:00:02.000Z',
        content: assistantToolContent('ProcessMapWrite', {
          title: '스킬 작성 루프',
          status: 'running',
          scope: { type: 'command', command: '/skill-architect' },
          steps: [
            { id: 'inspect', label: '현재 스킬 확인', status: 'completed', owner: 'ai', summary: '기존 지침을 확인합니다.' },
            { id: 'revise', label: '스킬 수정', status: 'running', owner: 'ai', needs: ['수정 방향'] },
          ],
        }),
      },
    ] as any);

    const map = await getSessionProcessMap({ sessionId: 's-chat', projectId: 'p1', title: '채팅 세션' });

    expect(map).toMatchObject({
      title: '스킬 작성 루프',
      status: 'running',
      sourceRefs: { source: 'ProcessMapWrite', messageId: 'm-pmw' },
    });
    expect(map.nodes).toHaveLength(2);
    expect(map.nodes[1]).toMatchObject({
      id: 'pmw:revise',
      label: '스킬 수정',
      status: 'running',
      owner: 'ai',
    });
    expect(map.nodes[1].evidence?.logs).toEqual(['Needs: 수정 방향']);
  });

  it('projects command_invocation events into a runtime draft command map with completed status', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    vi.mocked(query).mockResolvedValueOnce([
      {
        id: 'c-start',
        project_id: 'p1',
        session_id: 's-chat',
        automation_id: null,
        run_id: null,
        source_type: 'command_invocation',
        source_id: 'slash:native:skills',
        event_type: 'step_started',
        raw_label: 'Command started: 스킬',
        raw_payload: { commandId: 'native:skills', commandKind: 'native', displayName: '스킬', canonicalCommand: '/skills', trigger: 'slash', phase: 'started' },
        occurred_at: '2026-06-30T00:00:00.000Z',
        created_at: '2026-06-30T00:00:00.000Z',
      },
      {
        id: 'c-done',
        project_id: 'p1',
        session_id: 's-chat',
        automation_id: null,
        run_id: null,
        source_type: 'command_invocation',
        source_id: 'slash:native:skills',
        event_type: 'step_completed',
        raw_label: 'Command completed: 스킬',
        raw_payload: { commandId: 'native:skills', commandKind: 'native', displayName: '스킬', canonicalCommand: '/skills', trigger: 'slash', phase: 'completed' },
        occurred_at: '2026-06-30T00:00:01.000Z',
        created_at: '2026-06-30T00:00:01.000Z',
      },
    ] as any);

    const map = await getSessionProcessMap({ sessionId: 's-chat', projectId: 'p1', title: '채팅 세션' });
    const executionNode = map.nodes.find((node) => node.id === 'command:slash:native:skills');
    const runtimeNode = map.nodes.find((node) => node.id === 'command:slash:native:skills:runtime:frame');

    expect(executionNode).toMatchObject({
      label: 'Command · 스킬',
      status: 'completed',
      owner: 'system',
      automationLevel: 'auto',
    });
    expect(executionNode?.evidence?.eventIds).toEqual(['c-start', 'c-done']);
    expect(runtimeNode).toMatchObject({
      label: '요청과 실행 맥락 확인',
      status: 'completed',
      owner: 'system',
      automationLevel: 'auto',
    });
    expect(runtimeNode?.summary).toContain('runtime이 이번 요청');
    expect(map.sourceRefs).toMatchObject({ latestExecutionNodeId: 'command:slash:native:skills', activityNodeCount: 1 });
  });

  it('projects skill_invocation events into a Skill node with completed status', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      {
        id: 'e-start',
        project_id: 'p1',
        session_id: 's1',
        automation_id: 'a1',
        run_id: 'r1',
        source_type: 'skill_invocation',
        source_id: 'picker:meeting-prep',
        event_type: 'step_started',
        raw_label: 'Skill started: 회의 준비',
        raw_payload: { skillName: 'meeting-prep', displayName: '회의 준비', trigger: 'picker', source: 'project', phase: 'started' },
        occurred_at: '2026-06-30T00:00:00.000Z',
        created_at: '2026-06-30T00:00:00.000Z',
      },
      {
        id: 'e-done',
        project_id: 'p1',
        session_id: 's1',
        automation_id: 'a1',
        run_id: 'r1',
        source_type: 'skill_invocation',
        source_id: 'picker:meeting-prep',
        event_type: 'step_completed',
        raw_label: 'Skill completed: 회의 준비',
        raw_payload: { skillName: 'meeting-prep', displayName: '회의 준비', trigger: 'picker', source: 'project', phase: 'completed' },
        occurred_at: '2026-06-30T00:00:01.000Z',
        created_at: '2026-06-30T00:00:01.000Z',
      },
    ] as any);

    const automation = {
      id: 'a1',
      name: '회의 준비 자동화',
      description: '회의 준비',
      projectId: 'p1',
      jobType: 'ai_prompt',
      triggerType: 'manual',
      createdBySessionId: 's0',
      sessionId: 's0',
    } as Automation;
    const run = {
      id: 'r1',
      automationId: 'a1',
      status: 'success',
      trigger: 'manual',
      ranAt: '2026-06-30T00:00:00.000Z',
      startedAt: '2026-06-30T00:00:00.000Z',
      finishedAt: '2026-06-30T00:00:02.000Z',
    } as AutomationRun;

    const map = await getAutomationRunProcessMap(automation, run);
    const skillNode = map.nodes.find((node) => node.kind === 'skill');

    expect(skillNode).toMatchObject({
      id: 'skill:picker:meeting-prep',
      label: 'Skill · 회의 준비',
      status: 'completed',
      owner: 'ai',
      automationLevel: 'assisted',
    });
    expect(skillNode?.summary).toContain('trigger=picker');
    expect(skillNode?.evidence?.eventIds).toEqual(['e-start', 'e-done']);
  });

  it('builds a chat session runtime draft from skill invocation events', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    vi.mocked(query).mockResolvedValueOnce([
      {
        id: 'e-start',
        project_id: 'p1',
        session_id: 's-chat',
        automation_id: null,
        run_id: null,
        source_type: 'skill_invocation',
        source_id: 'slash:meeting-prep',
        event_type: 'step_started',
        raw_label: 'Skill started: 회의 준비',
        raw_payload: { skillName: 'meeting-prep', displayName: '회의 준비', trigger: 'slash', source: 'project', phase: 'started' },
        occurred_at: '2026-06-30T00:00:00.000Z',
        created_at: '2026-06-30T00:00:00.000Z',
      },
    ] as any);

    const map = await getSessionProcessMap({ sessionId: 's-chat', projectId: 'p1', title: '채팅 세션' });

    expect(map).toMatchObject({
      id: 'session:s-chat',
      source: 'chat',
      status: 'running',
      title: '채팅 세션 Run Canvas',
    });
    expect(map.nodes.map((node) => node.kind)).toEqual(['user_intent', 'skill', 'skill', 'ai_step', 'artifact']);
    expect(map.nodes[1]).toMatchObject({ label: 'Skill · 회의 준비', status: 'running' });
    expect(map.nodes[2]).toMatchObject({ label: '요청과 실행 맥락 확인', status: 'running' });
    expect(map.sourceRefs).toMatchObject({ latestExecutionNodeId: 'skill:slash:meeting-prep', activityNodeCount: 1 });
  });
});
