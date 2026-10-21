// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamManagementPanel } from './TeamManagementPanel';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, options: { defaultValue: string }) => options.defaultValue }) }));
const teams = [{ id: 'research', name: '리서치', state: 'active', version: 3 }, { id: 'sales', name: '영업', state: 'active', version: 1 }];
const people = [{ id: 7, username: 'member-a' }];
const projects = [{ id: 'agent-a', name: '자료 분석' }];
const hash = 'a'.repeat(64);
const fetchMock = vi.fn();
let applyResponse: (() => Promise<Response>) | undefined;
let previewResponse: (() => Promise<Response>) | undefined;
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
function receipt(command: Record<string, unknown>, expiresAt = new Date(Date.now() + 600_000).toISOString()) {
  return { intentId: '8ee51560-59ea-4d03-ab1b-12ef451f41f5', proposalHash: hash, expiresAt,
    preview: { actorUserId: 1, command, expected: { teamVersion: 3, teamState: 'active', memberState: null, assignedTeamId: null, workspaceIds: ['files-a'] }, warnings: ['서버 경고: 기존 파일이 공유될 수 있습니다.'] },
    impact: { eligibleAgentCount: null, registeredWorkspaceCount: null, affectedOwnSessionCount: null, note: '영향 개수는 미확인입니다.', warning: '외부 스냅샷은 자동 회수되지 않습니다.' } };
}
function commandAt(url: string) { return JSON.parse(fetchMock.mock.calls.findLast(([path]) => path === url)?.[1].body); }
async function ready() { render(<TeamManagementPanel users={people} projects={projects} />); await screen.findByLabelText('팀 선택'); }
async function fillCreate() {
  await ready();
  fireEvent.change(screen.getByLabelText('팀 이름'), { target: { value: '새 팀' } });
  fireEvent.change(screen.getByLabelText('새 팀 ID'), { target: { value: 'new-team' } });
}
async function preview() { fireEvent.click(screen.getByRole('button', { name: '변경 미리보기' })); await screen.findByRole('region', { name: '변경 검토' }); }
function choose(kind: string, teamId = 'research') {
  fireEvent.change(screen.getByLabelText('팀 선택'), { target: { value: teamId } });
  fireEvent.change(screen.getByLabelText('변경 종류'), { target: { value: kind } });
}
beforeEach(() => {
  localStorage.setItem('token', 'test-token');
  applyResponse = undefined; previewResponse = undefined;
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/agent-teams') return json({ teams });
    if (url === '/api/agent-teams/preview') return previewResponse ? previewResponse() : json(receipt(JSON.parse(String(init?.body))));
    if (url === '/api/agent-teams/apply') return applyResponse ? applyResponse() : json({ changed: true, teamVersion: 4 });
    return json({ team: teams.find(team => url.endsWith(team.id)), members: [{ userId: 7, role: 'member', state: 'active' }], agents: [{ projectId: 'agent-a' }] });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });

describe('TeamManagementPanel 사용자 행동', () => {
  it('정확한 생성 명령을 preview하고 명시 승인 전 apply하지 않는다', async () => {
    await fillCreate(); await preview();
    expect(commandAt('/api/agent-teams/preview')).toEqual({ kind: 'create', name: '새 팀', teamId: 'new-team' });
    expect(screen.getByText(hash)).toBeTruthy();
    expect(screen.getByText('서버 경고: 기존 파일이 공유될 수 있습니다.')).toBeTruthy();
    expect(screen.getByText('현재 팀 버전')).toBeTruthy();
    expect(screen.getByText(/미확인.*0개/)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/apply'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '승인하고 적용' }));
    await screen.findByText(/팀 설정에 반영했습니다/);
    expect(commandAt('/api/agent-teams/apply')).toEqual({ intentId: '8ee51560-59ea-4d03-ab1b-12ef451f41f5', proposalHash: hash, confirmed: true });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
    expect(screen.queryByRole('region', { name: '변경 검토' })).toBeNull();
    expect(screen.queryByText('파일 공유가 완료되었습니다')).toBeNull();
  });

  it('이름과 ID로 사람·Agent를 선택하고 strict 명령만 전송한다', async () => {
    await ready(); choose('invite');
    await screen.findByText('member-a (#7) · active');
    fireEvent.change(screen.getByLabelText('대상 사용자'), { target: { value: '7' } }); await preview();
    expect(commandAt('/api/agent-teams/preview')).toEqual({ kind: 'invite', teamId: 'research', userId: 7 });
    fireEvent.change(screen.getByLabelText('변경 종류'), { target: { value: 'revoke' } });
    await preview(); expect(commandAt('/api/agent-teams/preview')).toEqual({ kind: 'revoke', teamId: 'research', userId: 7 });
    fireEvent.change(screen.getByLabelText('변경 종류'), { target: { value: 'assign' } });
    fireEvent.change(screen.getByLabelText('대상 Agent'), { target: { value: 'agent-a' } }); await preview();
    expect(commandAt('/api/agent-teams/preview')).toEqual({ kind: 'assign', teamId: 'research', projectId: 'agent-a' });
    expect(screen.getAllByText(/자기 대화/).length).toBeGreaterThan(0);
  });

  it('취소·입력 변경·팀 선택은 승인 대상을 폐기한다', async () => {
    await fillCreate(); await preview(); fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.queryByRole('region', { name: '변경 검토' })).toBeNull();
    await preview(); fireEvent.change(screen.getByLabelText('팀 이름'), { target: { value: '다른 팀' } });
    expect(screen.queryByRole('button', { name: '승인하고 적용' })).toBeNull();
    await preview(); fireEvent.change(screen.getByLabelText('팀 선택'), { target: { value: 'research' } });
    expect(screen.queryByRole('button', { name: '승인하고 적용' })).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/apply'))).toHaveLength(0);
  });

  it('preview 응답 대기 중 편집해도 늦은 응답을 승인할 수 없다', async () => {
    let resolve!: (value: Response) => void;
    previewResponse = () => new Promise<Response>(done => { resolve = done; });
    await fillCreate(); fireEvent.click(screen.getByRole('button', { name: '변경 미리보기' }));
    const pendingSignal = fetchMock.mock.calls.findLast(([url]) => url.endsWith('/preview'))?.[1].signal as AbortSignal;
    fireEvent.change(screen.getByLabelText('팀 이름'), { target: { value: '편집 후' } });
    expect(pendingSignal.aborted).toBe(true);
    await act(async () => { resolve(json(receipt({ kind: 'create', teamId: 'new-team', name: '새 팀' }))); });
    expect(screen.queryByRole('button', { name: '승인하고 적용' })).toBeNull();
  });

  it('중복 승인을 막고 실패한 preview는 폐기하여 재검토를 요구한다', async () => {
    let resolve!: (value: Response) => void;
    applyResponse = () => new Promise<Response>(done => { resolve = done; });
    await fillCreate(); await preview();
    const button = screen.getByRole('button', { name: '승인하고 적용' });
    fireEvent.click(button); fireEvent.click(button);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/apply'))).toHaveLength(1);
    await act(async () => { resolve(json({ error: 'TEAM_MANAGEMENT_PREVIEW_STALE' }, 409)); });
    expect(screen.getByRole('alert').textContent).toContain('다시 미리보기');
    expect(screen.queryByRole('button', { name: '승인하고 적용' })).toBeNull();
    expect(screen.queryByText(/팀 설정에 반영했습니다/)).toBeNull();
  });

  it('만료되면 자동으로 preview를 폐기한다', async () => {
    await fillCreate();
    previewResponse = async () => json(receipt({ kind: 'create', teamId: 'new-team', name: '새 팀' }, new Date(Date.now() + 150).toISOString()));
    await preview();
    await waitFor(() => expect(screen.queryByRole('button', { name: '승인하고 적용' })).toBeNull());
    expect(screen.getByRole('alert').textContent).toContain('만료');
  });

  it.each([[404, '기능이 비활성화'], [403, '현재 권한']])('%i는 기능 또는 권한 상태로 안내하고 변경 form을 숨긴다', async (status, text) => {
    fetchMock.mockResolvedValue(json({ error: status === 404 ? 'TEAM_MANAGEMENT_INACTIVE' : 'TEAM_MANAGEMENT_ADMIN_REQUIRED' }, status));
    render(<TeamManagementPanel />);
    await screen.findByRole('alert'); expect(screen.getByRole('alert').textContent).toContain(text);
    expect(screen.queryByRole('button', { name: '변경 미리보기' })).toBeNull();
  });

  it('목록 loading·error·retry·empty 상태를 제공한다', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    render(<TeamManagementPanel />);
    expect(screen.getByRole('status').textContent).toContain('불러오는 중');
    await screen.findByRole('alert'); fetchMock.mockResolvedValue(json({ teams: [] }));
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await screen.findByText('아직 등록된 팀이 없습니다.');
    expect(screen.getByRole('button', { name: '변경 미리보기' })).toBeTruthy();
  });

  it('상세 조회 실패는 오래된 구성원을 표시하지 않으며 다시 시도한다', async () => {
    await ready();
    fetchMock.mockImplementation(async (url: string) => url === '/api/agent-teams' ? json({ teams }) : json({ error: 'TEAM_MANAGEMENT_UNAVAILABLE' }, 500));
    choose('invite'); await screen.findByRole('alert');
    expect(screen.queryByText('member-a (#7) · active')).toBeNull();
    expect((screen.getByRole('button', { name: '변경 미리보기' }) as HTMLButtonElement).disabled).toBe(true);
    fetchMock.mockResolvedValue(json({ team: teams[0], members: [], agents: [] }));
    fireEvent.click(screen.getByRole('button', { name: '구성원 다시 불러오기' }));
    await screen.findByText('등록된 구성원이 없습니다.');
  });

  it('부모 users/projects가 없어도 논리 ID로 입력하며 다른 디렉터리 API를 호출하지 않는다', async () => {
    render(<TeamManagementPanel />); await screen.findByLabelText('팀 선택'); choose('revoke');
    await screen.findByText('#7 · active');
    fireEvent.change(screen.getByLabelText('대상 사용자'), { target: { value: '7' } }); await preview();
    expect(commandAt('/api/agent-teams/preview')).toEqual({ kind: 'revoke', teamId: 'research', userId: 7 });
    fireEvent.change(screen.getByLabelText('변경 종류'), { target: { value: 'assign' } });
    fireEvent.change(screen.getByLabelText('대상 Agent'), { target: { value: 'agent-a' } }); await preview();
    expect(commandAt('/api/agent-teams/preview')).toEqual({ kind: 'assign', teamId: 'research', projectId: 'agent-a' });
    expect(fetchMock.mock.calls.every(([url]) => url.startsWith('/api/agent-teams'))).toBe(true);
  });

  it('패널을 닫으면 대기 중인 요청을 중단한다', async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const view = render(<TeamManagementPanel />);
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false); view.unmount(); expect(signal.aborted).toBe(true);
  });

  it('preview 도중 권한이 철회되면 기존 승인과 변경 form을 제거한다', async () => {
    await fillCreate(); await preview();
    applyResponse = async () => json({ error: 'TEAM_MANAGEMENT_ADMIN_REQUIRED' }, 403);
    fireEvent.click(screen.getByRole('button', { name: '승인하고 적용' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('현재 권한');
    expect(screen.queryByRole('button', { name: '승인하고 적용' })).toBeNull();
    expect(screen.queryByRole('button', { name: '변경 미리보기' })).toBeNull();
    expect(screen.queryByText(/팀 설정에 반영했습니다/)).toBeNull();
  });

  it('잘못된 command/hash의 preview 응답은 승인하지 않는다', async () => {
    await fillCreate();
    previewResponse = async () => json(receipt({ kind: 'create', teamId: 'tampered-team', name: '새 팀' }));
    fireEvent.click(screen.getByRole('button', { name: '변경 미리보기' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: '승인하고 적용' })).toBeNull();
    previewResponse = async () => json({ ...receipt({ kind: 'create', teamId: 'new-team', name: '새 팀' }), proposalHash: 'invalid' });
    fireEvent.click(screen.getByRole('button', { name: '변경 미리보기' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/preview'))).toHaveLength(2));
    expect(screen.queryByRole('button', { name: '승인하고 적용' })).toBeNull();
  });

  it('팀을 바꾸면 늦게 도착한 이전 팀 상세를 표시하지 않는다', async () => {
    await ready();
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementation(async (url: string) => url.endsWith('research') ? new Promise<Response>(done => { resolve = done; }) : json({ team: teams[1], members: [], agents: [] }));
    choose('invite', 'research');
    fireEvent.change(screen.getByLabelText('팀 선택'), { target: { value: 'sales' } });
    await screen.findByText('등록된 구성원이 없습니다.');
    await act(async () => { resolve(json({ team: teams[0], members: [{ userId: 7, state: 'active', role: 'member' }], agents: [] })); });
    expect(screen.queryByText('member-a (#7) · active')).toBeNull();
  });

  it('알 수 없는 서버 상태는 유효한 구성 또는 승인으로 취급하지 않는다', async () => {
    fetchMock.mockResolvedValueOnce(json({ teams: [{ ...teams[0], state: 'mystery' }] }));
    render(<TeamManagementPanel />); await screen.findByRole('alert');
    expect(screen.queryByLabelText('팀 선택')).toBeNull();
    fetchMock.mockResolvedValueOnce(json({ teams }));
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await screen.findByLabelText('팀 선택');
    fireEvent.change(screen.getByLabelText('팀 이름'), { target: { value: '새 팀' } });
    fireEvent.change(screen.getByLabelText('새 팀 ID'), { target: { value: 'new-team' } });
    previewResponse = async () => {
      const result = receipt({ kind: 'create', teamId: 'new-team', name: '새 팀' });
      result.preview.expected.teamState = 'mystery'; return json(result);
    };
    fireEvent.click(screen.getByRole('button', { name: '변경 미리보기' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: '승인하고 적용' })).toBeNull();
  });

  it('미리보기 영역을 커밋한 시점에 제목으로 포커스를 옮긴다', async () => {
    const focusedAtCommit: boolean[] = [];
    render(<React.Profiler id="team-review" onRender={() => {
      const heading = screen.queryByRole('heading', { name: '변경 검토' });
      if (heading) focusedAtCommit.push(document.activeElement === heading);
    }}><TeamManagementPanel users={people} projects={projects} /></React.Profiler>);
    await screen.findByLabelText('팀 선택');
    fireEvent.change(screen.getByLabelText('팀 이름'), { target: { value: '새 팀' } });
    fireEvent.change(screen.getByLabelText('새 팀 ID'), { target: { value: 'new-team' } });
    await preview();
    expect(focusedAtCommit.length).toBeGreaterThan(0);
    expect(focusedAtCommit.every(Boolean)).toBe(true);
  });

  it('취소는 미리보기로 포커스를 돌려주고 공유 실행기 한계를 계속 표시한다', async () => {
    await fillCreate(); await preview();
    expect(document.activeElement?.textContent).toBe('변경 검토');
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '변경 미리보기' }));
    expect(screen.getByText(/미지원 환경에서는 파일 공유가 동작하지 않습니다/)).toBeTruthy();
  });

  it('executor 미준비 또는 malformed 응답을 성공으로 알리지 않는다', async () => {
    await fillCreate(); await preview();
    applyResponse = async () => json({ error: 'TEAM_EXECUTOR_NOT_READY' }, 503);
    fireEvent.click(screen.getByRole('button', { name: '승인하고 적용' })); await screen.findByRole('alert');
    expect(screen.queryByText(/팀 설정에 반영했습니다/)).toBeNull();
    await preview(); applyResponse = async () => json({});
    fireEvent.click(screen.getByRole('button', { name: '승인하고 적용' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('확인할 수 없습니다'));
    expect(screen.queryByText(/팀 설정에 반영했습니다/)).toBeNull();
  });
});
