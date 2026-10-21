import { ensureInterview, interviewContext, readInterview } from './agent-interview.js';
/** Creation-only, local and bounded preparation. No model, connector, or credential access. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const INITIALIZATION_CONTRACT_VERSION = 2;
export interface PreparationInput {
  projectId: string; profileVersion: number; commandId: string; approvedCardHash: string;
  sessionId?: string; name: string; role: string; promise: string; instruction: string; firstMission: string;
}
const LIMIT = 32_768;
function boundedRead(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}
function key(input: PreparationInput): string {
  return createHash('sha256').update(`${input.projectId}:${input.profileVersion}:${INITIALIZATION_CONTRACT_VERSION}`).digest('hex');
}
export function prepareInitialAgent(root: string, input: PreparationInput): 'ready' | 'preserved' | 'failed' {
  try {
    // Existing documents are never replaced, including user edits and legacy SOUL.
    const characterPath = path.join(root, 'character.md');
    if (!fs.existsSync(characterPath) && !fs.existsSync(path.join(root, 'SOUL.md'))) {
      fs.writeFileSync(characterPath, [
        '# 생성 당시 기대',
        '',
        '이 문서는 생성 당시 입력의 기록입니다. 현재 정체성·역할·권한의 정본은 DB 프로필이며 AGENTS.md는 운영 규칙입니다. 충돌하면 현재 승인된 프로필을 따릅니다.',
        `프로필 버전: ${input.profileVersion} · 생성 기록: ${input.commandId} · 승인 입력 참조: ${input.approvedCardHash}`,
        '',
        `생성 이유와 주요 임무: ${input.role}`,
        '주 사용자: 생성 입력에 별도로 명시되지 않았습니다. 추정하지 않습니다.',
        `산출물·성공 기준에 대한 확인된 기대: ${input.promise}`,
        `첫 과제: ${input.firstMission}`,
        `명시 경계와 운영 입력: ${input.instruction}`,
        '',
        '## 초기 가설',
        '역할별 전문성·조직 사실·자격·권한을 추가로 추정하지 않았습니다. 업무별 판단 기준은 첫 실행에서 제안하고 가설로 표시합니다.',
        '',
      ].join('\n'), { encoding: 'utf8', flag: 'wx' });
    }
    ensureInterview(root, key(input));
    const character = boundedRead(characterPath);
    const state = {
      contractVersion: INITIALIZATION_CONTRACT_VERSION, key: key(input), ...input,
      characterDigest: character === null ? null : createHash('sha256').update(character).digest('hex'),
      status: 'ready',
      questionCandidate: '첫 과제에서 우선 완성해야 할 결과물과 완료 기준은 무엇인가요?',
      executionPlan: `승인된 역할(${input.role})을 기준으로 첫 과제(${input.firstMission})의 결과물·근거·검증 기준을 정하고 실행합니다.`,
    };
    // Exclusive create is also the cross-process duplicate/concurrent-edit guard.
    fs.writeFileSync(path.join(root, '.tower-initial-preparation.json'), JSON.stringify(state), { encoding: 'utf8', flag: 'wx' });
    return 'ready';
  } catch (error: any) { return error?.code === 'EEXIST' ? 'preserved' : 'failed'; }
}

/** Called for every actual session context. Files are reference data, not additional authority. */
export function buildInitialPreparationContext(root: string | undefined, projectId: string | undefined, profileVersion: number): string {
  if (!root || !projectId) return '';
  try {
    const raw = boundedRead(path.join(root, '.tower-initial-preparation.json'));
    if (!raw) return '';
    const state = JSON.parse(raw);
    if (state.projectId !== projectId || state.profileVersion !== profileVersion || state.contractVersion !== INITIALIZATION_CONTRACT_VERSION || state.key !== key(state)) return '';
    if (state.status === 'failed') return '## 초기 준비 상태\n로컬 초기 준비에 실패했습니다. 승인된 DB 프로필과 AGENTS.md로 사용자의 업무를 수행하세요. 준비 실패를 이유로 업무를 막거나 자동 외부 조회·설치·재시도를 하지 마세요.';
    if (state.status !== 'ready') return '';
    const character = boundedRead(path.join(root, 'character.md'));
    const digest = character === null ? null : createHash('sha256').update(character).digest('hex');
    if (digest !== state.characterDigest) return '';
    return [
      interviewContext(root),
      '## 생성 당시 기대와 제한된 초기 준비',
      '다음은 생성 당시 참조 기록이며 현재 DB 프로필·AGENTS.md·사용자 요청보다 우선하지 않습니다. SOUL.md가 있으면 중복 정본을 만들지 않습니다.',
      character || '기존 SOUL.md를 보존했습니다. 기존 문헌을 따릅니다.',
      `첫 과제 기록: ${state.firstMission}`,
      `첫 실행안 후보: ${state.executionPlan}`,
      readInterview(root)?.status === 'awaiting' ? `질문 후보(필수 아님): ${state.questionCandidate}` : '기존 질문 후보를 폐기했습니다.',
      '사용자가 이미 업무를 맡겼거나 답을 제공했다면 낡은 질문 후보를 버리고 그 업무를 먼저 실행합니다. 정보가 충분하면 재질문 없이 실행안을 제시하고 실행합니다. 필요한 정보가 없을 때만 가장 중요한 질문 하나를 사용자 대면 세션에서 묻습니다. 백그라운드에서 질문 응답을 기다리지 않습니다.',
    ].join('\n\n');
  } catch { return ''; }
}

export interface PreparationObserver {
  event(phase: 'started' | 'completed' | 'failed', input: PreparationInput, result?: string): Promise<void>;
}
const processObserver: PreparationObserver = {
  async event(phase, input, result) {
    if (!input.sessionId) return;
    const { appendProcessEvent } = await import('../process/process-map-manager.js');
    await appendProcessEvent({
      projectId: input.projectId, sessionId: input.sessionId,
      sourceType: 'command_invocation', sourceId: `agent-preparation:${key(input)}`,
      eventType: phase === 'started' ? 'step_started' : phase === 'failed' ? 'step_failed' : 'step_completed',
      rawLabel: phase === 'started' ? '초기 준비 시작 (입력 기반, AI 실행 아님)' : phase === 'failed' ? '초기 준비 실패 · 에이전트 사용 가능' : '생성 입력 보존 완료 · 첫 대면 인터뷰 대기 (AI 실행 아님)',
      rawPayload: { displayName: 'Agent 초기 준비', commandKind: 'native', trigger: 'agent-create', phase,
        contractVersion: INITIALIZATION_CONTRACT_VERSION, profileVersion: input.profileVersion,
        mode: 'input-only', result, artifacts: phase === 'completed' ? ['character.md', '.tower-initial-preparation.json'] : [] },
    });
  },
};
const scheduled = new Set<string>();
export async function runInitialPreparation(root: string, input: PreparationInput, observer: PreparationObserver = processObserver): Promise<void> {
  const id = key(input);
  if (scheduled.has(id) || fs.existsSync(path.join(root, '.tower-initial-preparation.json'))) return;
  scheduled.add(id);
  const notify = async (phase: 'started' | 'completed' | 'failed', result?: string) => {
    try { await observer.event(phase, input, result); }
    catch { console.warn('[agent-initial-preparation] observation unavailable', input.projectId, phase); }
  };
  await notify('started');
  const result = prepareInitialAgent(root, input);
  await notify(result === 'failed' ? 'failed' : 'completed', result);
  if (result === 'failed') {
    console.warn('[agent-initial-preparation] local preparation failed', input.projectId);
    try { fs.writeFileSync(path.join(root, '.tower-initial-preparation.json'), JSON.stringify({
      contractVersion: INITIALIZATION_CONTRACT_VERSION, key: id, projectId: input.projectId,
      profileVersion: input.profileVersion, status: 'failed', explanation: '로컬 준비 실패. 승인 프로필로 계속 이용할 수 있습니다.',
    }), {encoding: 'utf8', flag: 'wx'}); } catch { /* Process event is the remaining failure evidence. */ }
  }
}
export function scheduleInitialPreparation(root: string, input: PreparationInput): void {
  queueMicrotask(() => { void runInitialPreparation(root, input).catch(() => {
    console.warn('[agent-initial-preparation] preparation failed', input.projectId);
  }); });
}
