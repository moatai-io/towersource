import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const frontendDir = import.meta.dirname;
const home = fs.readFileSync(path.join(frontendDir, 'WorkspaceAppsHome.tsx'), 'utf8');
const actionBar = fs.readFileSync(path.join(frontendDir, 'WorkspaceAppActionBar.tsx'), 'utf8');
const recordPanel = fs.readFileSync(path.join(frontendDir, 'WorkspaceAppRecordPanel.tsx'), 'utf8');
const tableView = fs.readFileSync(path.join(frontendDir, 'WorkspaceAppTableView.tsx'), 'utf8');
const client = fs.readFileSync(path.join(frontendDir, 'workspace-app-api.ts'), 'utf8');
const route = fs.readFileSync(path.resolve(frontendDir, '../../../../backend/routes/workspace-apps-api.ts'), 'utf8');
const decision = fs.readFileSync(path.resolve(frontendDir, '../../../../../docs/design-explorations/2026-08-12-workspace-apps-metadata-driven-business-workflow-renderer.md'), 'utf8');

describe('Workspace Apps register-style business workflow', () => {
  it('moves the primary surface from app editing to business actions', () => {
    expect(home).toContain('WorkspaceAppActionBar');
    expect(actionBar).toContain('신규 등록');
    expect(actionBar).toContain('선택 수정');
    expect(actionBar).toContain('상태 변경');
    expect(actionBar).toContain('CSV 출력');
    expect(actionBar).toContain('검색');
    expect(home).not.toContain('세션에서 수정 요청하기');
  });

  it('supports row selection and a right-side record panel before enabling writes', () => {
    expect(tableView).toContain('selectedRowIndex');
    expect(tableView).toContain('onSelectRow');
    expect(home).toContain('setSelectedRow(row)');
    expect(recordPanel).toContain('상세 보기');
    expect(recordPanel).toContain('신규 등록');
    expect(recordPanel).toContain('저장은 화면 정의에 등록된 업무 action만 실행합니다');
    expect(client).toContain('executeWorkspaceAppAction');
    expect(route).toContain("router.post('/:appId/actions/:actionId'");
  });

  it('records the renderer architecture decision', () => {
    expect(decision).toContain('React 공통 업무 앱 renderer');
    expect(decision).toContain('업무 앱은 metadata로 정의한다');
    expect(decision).toContain('업무 action executor');
  });
});
