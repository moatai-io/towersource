/**
 * Owns: the durable first-day handoff brief seeded in a new Primary Agent Workspace.
 * Public API: renderPrimaryAgentOnboardingDocument, ensurePrimaryAgentOnboardingDocument.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface PrimaryAgentOnboardingDocumentInput {
  name: string;
  expectedExpertise: string;
}

function inline(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Render a living handoff and working agreement, not an automation questionnaire. */
export function renderPrimaryAgentOnboardingDocument(input: PrimaryAgentOnboardingDocumentInput): string {
  const name = inline(input.name);
  const expertise = inline(input.expectedExpertise);
  return `# ${name} · 첫 출근과 업무 인수인계

- 상태: 합류·학습 중
- 생성 시 사용자가 적은 기대: ${expertise}
- 문서 원칙: 확인된 사실만 확정하고, 아직 모르는 내용은 **TBD**로 둔다.

## 이 문서의 목적

이 문서는 입사 설문이나 자동화 기획서가 아니다. ${name}이 팀의 맥락을 반복해서 묻지 않고 실제 일을 맡아갈 수 있도록, 생성 시점의 기대와 협업 중 확인된 업무 계약을 축적하는 살아 있는 문서다.

## 시작 맥락

### 합류 목적

${expertise}

### 첫 업무

실제 업무와 자동화 후보 발굴

### 기본 승인 경계

- 다른 Workspace 접근: 명시적 대상과 ACL 확인
- Credential 사용: 필요한 시점에 안전 입력·연결 확인
- 외부 발송·게시, 삭제·대량 변경, 비용 발생, 운영환경 변경: 실행 직전 사람 확인

## 첫 주에 함께 맞출 것

- 이 동료가 책임질 결과와 이를 사용하는 사람: TBD
- 지금 가장 먼저 도울 실제 업무: TBD
- 권위 있는 자료와 시스템: TBD
- 좋은 결과의 기준: TBD
- 스스로 진행할 수 있는 범위: TBD
- 반드시 사람에게 확인할 지점: TBD

## 첫 업무 기록

| 항목 | 확인 내용 |
|---|---|
| 요청 또는 시작 신호 | TBD |
| 입력 자료 | TBD |
| 함께 만든 결과 | TBD |
| 결과를 사용할 사람 | TBD |
| 완료 기준 | TBD |
| 사람 확인 지점 | TBD |
| 예외·리스크 | TBD |

## 업무 흐름

실제 업무를 함께 한 뒤 도움이 될 때만 이 도식을 구체화한다. 모르는 단계를 그럴듯하게 채우지 않는다.

\`\`\`mermaid
flowchart LR
  A["요청·시작 신호 · TBD"] --> B["자료와 맥락 · TBD"]
  B --> C["함께 수행할 일 · TBD"]
  C --> D["사람 확인 · TBD"]
  D --> E["완료 결과 · TBD"]
\`\`\`

## 업무 계약

### 맡길 수 있는 일

- TBD

### 아직 사람이 맡아야 하는 일

- TBD

### 커뮤니케이션 방식

- 진행 중 공유할 시점: TBD
- 막혔을 때 도움을 요청할 방식: TBD
- 결과를 전달할 형식과 위치: TBD

## 자료와 접근

- 권위 있는 자료: TBD
- Project 안의 산출물 위치: TBD
- 필요한 Connector 또는 Credential: TBD
- 개인정보·보안 경계: TBD

## 성장 backlog

반복 증거가 생긴 뒤에만 자동화·스킬·Connector 후보를 기록한다.

| 후보 | 필요한 이유 | 성공 증거 | 사람 확인 | 상태 |
|---|---|---|---|---|
| TBD | TBD | TBD | TBD | 관찰 중 |

## 열린 질문

- 오늘 바로 같이 해볼 일 또는 먼저 볼 자료는 무엇인가?

## 결정 기록

| 날짜 | 결정 | 근거가 된 실제 협업 |
|---|---|---|
| TBD | TBD | TBD |
`;
}

/** Create the onboarding handoff once. Resume paths never overwrite discoveries. */
export function ensurePrimaryAgentOnboardingDocument(rootPath: string, input: PrimaryAgentOnboardingDocumentInput): void {
  if (!rootPath?.trim()) throw new Error('Project root path is required to materialize Primary Agent onboarding');
  const target = path.join(rootPath, 'ONBOARDING.md');
  if (!fs.existsSync(target)) fs.writeFileSync(target, renderPrimaryAgentOnboardingDocument(input), 'utf8');
  const verified = fs.readFileSync(target, 'utf8');
  if (!verified.includes('# ') || !verified.includes('## 시작 맥락') || !verified.includes('## 업무 계약') || !verified.includes('```mermaid')) {
    throw new Error(`Primary Agent onboarding document verification failed: ${target}`);
  }
}
