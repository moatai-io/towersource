/**
 * policy.ts — Project Runtime Box 마운트 정책 헬퍼.
 *
 * Owns: feature flag 확인, excluded project 필터링.
 * Public API: isRuntimeBoxEnabled(), isProjectExcluded(projectId, projectName?).
 * See README.md.
 *
 * 설계 원칙:
 *  - 이 파일은 DB 쿼리를 하지 않는다. 순수하게 config 값만 읽어 판단.
 *  - pi-engine.ts 에서 import 해 customTools 마운트 여부를 결정.
 *  - excluded project 는 project ID(slug) 또는 project name 으로 매칭.
 *    매칭은 소문자 비교 — RUNTIME_BOX_EXCLUDED_PROJECTS 값도 소문자 정규화됨.
 *
 * 환경 변수:
 *  ENABLE_PROJECT_RUNTIME_BOX=true           → Runtime Box 활성
 *  RUNTIME_BOX_EXCLUDED_PROJECTS=tower,_team → ID/name 차단 목록
 *
 * 결정: workspace/decisions/2026-06-02-project-runtime-box-product-framing.md
 */

import { config } from '../../config.js';

/**
 * ENABLE_PROJECT_RUNTIME_BOX=true 일 때만 Runtime Box tools 마운트.
 *
 * 기본값은 false (opt-in) — 새 VM 에 배포해도 자동으로 켜지지 않음.
 * Tower 운영자가 명시적으로 env 를 설정해야 활성화됨.
 */
export function isRuntimeBoxEnabled(): boolean {
  return config.runtimeBox.enabled;
}

/**
 * RUNTIME_BOX_EXCLUDED_PROJECTS 에 포함된 프로젝트는 Runtime Box 제외.
 *
 * Tower 코어 프로젝트 (tower, _team 등) 와 admin-only 프로젝트를
 * Runtime Box 에서 원천 차단하기 위해 사용.
 *
 * @param projectId   projects.id (slug). 소문자 비교.
 * @param projectName projects.name (optional). 소문자 비교. ID 매칭 우선.
 */
export function isProjectExcluded(projectId: string, projectName?: string): boolean {
  const excluded = config.runtimeBox.excludedProjects;
  if (excluded.length === 0) return false;

  const idLower = projectId.toLowerCase();
  const nameLower = projectName?.toLowerCase();

  return excluded.some(e => e === idLower || (nameLower !== undefined && e === nameLower));
}
