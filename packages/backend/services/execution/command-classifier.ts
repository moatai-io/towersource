/**
 * command-classifier.ts — 명령어를 light / heavy / long-running / risky 로 분류.
 *
 * Owns: 명령 분류 로직.
 * Public API: classifyCommand(cmd), shouldSuppressCredentialEnv(cmd).
 * See README.md.
 *
 * 결정: workspace/decisions/2026-06-01-project-runtime-plane-devbox-services.md §명령 분류
 * 주의: 분류는 *보조*다. 완벽한 분류를 기대하지 말 것 (결정 §S15).
 *       명백히 장기/위험한 패턴만 잡아낸다.
 */

import { analyzeCommandStructure, serviceHint, isHeavyInvocation, invocationPort } from './command-structure.js';
import type { CommandClassification } from './types.js';

// ── 패턴 테이블 ──────────────────────────────────────────────────────────

/**
 * risky 패턴: 고위험 실행 후보 (Phase 2+ Secure Run 승격용).
 * v1 에서는 경고만 — 실행을 차단하지는 않음.
 */
const DOCKER_PATTERN = /\bdocker\b/;
const DOCKER_DIAGNOSTIC_ARGS = String.raw`(?:\s+(?:--?[\w.-]+)(?:[=\s]+(?:'[^']*'|"[^"]*"|[^\s]+))?)*`;
const READ_ONLY_DOCKER_INVOCATION = new RegExp(
  String.raw`^docker\s+(?:version${DOCKER_DIAGNOSTIC_ARGS}|info${DOCKER_DIAGNOSTIC_ARGS}|ps${DOCKER_DIAGNOSTIC_ARGS}|images${DOCKER_DIAGNOSTIC_ARGS}|inspect\b.*|compose\s+(?:version${DOCKER_DIAGNOSTIC_ARGS}|config${DOCKER_DIAGNOSTIC_ARGS}|ps${DOCKER_DIAGNOSTIC_ARGS}|images${DOCKER_DIAGNOSTIC_ARGS}))$`,
);

const RISKY_PATTERNS: RegExp[] = [
  /curl\s+.*\|\s*(bash|sh)\b/,
  /wget\s+.*\|\s*(bash|sh)\b/,
  /\bchmod\s+\+x\b/,
  /\bsudo\b/,
  /\bsu\s+-?\b/,
  /\bnsenter\b/,
  DOCKER_PATTERN,       // Mutating/unknown Docker commands require review.
  /\bpodman\b/,
  /\/proc\//,
  /\/sys\//,
  /\brm\s+-rf\s+\/\b/, // rm -rf / 또는 rm -rf /*
];

/**
 * Credential-free 패턴: 명령 자체는 실행할 수 있지만 Tower 가 맡긴 API key,
 * GitHub/Azure/GWS 토큰 등을 빌려주면 안 되는 명령.
 *
 * 원칙:
 * - 외부 코드를 내려받아 실행/설치하는 단계는 secret 없이 실행한다.
 * - env 전체를 출력하는 명령은 secret 유출 방지를 위해 secret 없이 실행한다.
 * - 일반 테스트/빌드/프로젝트 스크립트는 project connection 을 사용할 수 있다.
 */
const CREDENTIAL_SUPPRESS_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /curl\s+.*\|\s*(bash|sh)\b/, reason: 'remote script execution via curl pipe' },
  { re: /wget\s+.*\|\s*(bash|sh)\b/, reason: 'remote script execution via wget pipe' },
  { re: /(^|[;&|()\s])env(\s|$)/, reason: 'full environment print command' },
  { re: /(^|[;&|()\s])printenv(\s|$)/, reason: 'full environment print command' },
  { re: /\bnpm\s+(install|i|add)\b/, reason: 'external package install' },
  { re: /\byarn\s+(install|add)\b/, reason: 'external package install' },
  { re: /\bpnpm\s+(install|add)\b/, reason: 'external package install' },
  { re: /\bbun\s+(install|add)\b/, reason: 'external package install' },
  { re: /\bpip(?:3)?\s+install\b/, reason: 'external package install' },
  { re: /\buv\s+(add|pip\s+install)\b/, reason: 'external package install' },
  { re: /\bpoetry\s+add\b/, reason: 'external package install' },
];

const SIMPLE_FILE_INSPECTION_RE = /^\s*(pwd|ls|find|grep|rg|cat|head|tail|wc|sed\s+-n|git\s+status(?:\s+--short)?)(?:\s|$)/;

/**
 * True for short project-file inspection commands that do not need API keys or
 * external account credentials. This is intentionally conservative and only
 * drives UX hints / credential-free fast lanes; it never grants access.
 */
export function isSimpleFileInspectionCommand(cmd: string): boolean {
  const parts = cmd
    .split(/\n|&&|;/)
    .map(part => part.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 6) return false;
  return parts.every(part => SIMPLE_FILE_INSPECTION_RE.test(part));
}

// ── 분류 함수 ─────────────────────────────────────────────────────────────

/**
 * 명령어 문자열을 분석해 실행 클래스를 반환.
 * 순서: risky → long-running → heavy → light
 */
export function shouldSuppressCredentialEnv(cmd: string): { suppress: boolean; reason?: string } {
  const trimmed = cmd.trim();
  if (isSimpleFileInspectionCommand(trimmed)) {
    return { suppress: true, reason: 'project file inspection command' };
  }
  for (const { re, reason } of CREDENTIAL_SUPPRESS_PATTERNS) {
    if (re.test(trimmed)) return { suppress: true, reason };
  }
  return { suppress: false };
}

function containsOnlyReadOnlyDockerInvocations(command: string): boolean {
  const invocations = command.match(/\bdocker\s+[^\n;|&)`]+/g) ?? [];
  return invocations.length > 0 && invocations.every((invocation) => READ_ONLY_DOCKER_INVOCATION.test(invocation.trim()));
}

export function classifyCommand(cmd: string): CommandClassification {
  const trimmed = cmd.trim();

  // 1. risky 먼저 (최우선)
  for (const re of RISKY_PATTERNS) {
    if (re === DOCKER_PATTERN && containsOnlyReadOnlyDockerInvocations(trimmed)) continue;
    if (re.test(trimmed)) {
      return {
        cls: 'risky',
        reason: `Potentially risky pattern detected: \`${re.source}\`. Phase 2+에서 Secure Run 으로 승격 예정.`,
      };
    }
  }

  // Lifecycle inference only consumes executable argv, never quoted data.
  const commands = analyzeCommandStructure(trimmed);
  const name = commands?.map(serviceHint).find(Boolean);
  if (name) return { cls: 'long-running', reason: `실행 명령을 Service '${name}' 후보로 판별했습니다.`, suggested_service_name: name };

  if (commands?.some(isHeavyInvocation)) return { cls: 'heavy', reason: '설치/빌드/테스트 실행 명령으로 판별했습니다.' };

  // 4. light (기본)
  return {
    cls: 'light',
    reason: commands ? '자동 Job/Service 전환 근거가 없어 일반 실행합니다.' : '명령 구조가 불확실하여 자동 Job/Service 전환하지 않습니다.',
  };
}

// ── 서비스 승격 힌트 ─────────────────────────────────────────────────────

/**
 * long-running 으로 분류된 명령에서 포트 번호를 추출 (있으면).
 * 예: 'uvicorn main:app --port 8000' → 8000
 */
export function extractPortFromCommand(cmd: string): number | undefined {
  const commands = analyzeCommandStructure(cmd);
  if (!commands || !serviceHint(commands[0])) return undefined;
  return invocationPort(commands[0]);
}
