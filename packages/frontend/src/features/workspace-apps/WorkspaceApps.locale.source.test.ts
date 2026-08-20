import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => fs.readFileSync(path.resolve(__dirname, name), 'utf8');
const home = read('WorkspaceAppsHome.tsx');
const builder = read('WorkspaceAppBuilderPanel.tsx');
const record = read('WorkspaceAppRecordPanel.tsx');
const definition = read('WorkspaceAppDefinitionViewer.tsx');
const actions = read('WorkspaceAppActionBar.tsx');
const table = read('WorkspaceAppTableView.tsx');
const sidebar = read('WorkspaceAppSidebar.tsx');
const frappe = read('FrappeConnectorPilot.tsx');

describe('Workspace Apps locale contract', () => {
  it('routes local metadata screen chrome and notices through common locale keys', () => {
    for (const key of [
      'workspaceApps.publishConfirm.title',
      'workspaceApps.home.listTitle',
      'workspaceApps.notice.exportedCsv',
      'workspaceApps.notice.menuPreparing',
    ]) expect(home).toContain(key);
  });

  it('routes builder, record, definition, action, table, and sidebar chrome through locale keys', () => {
    expect(builder).toContain('workspaceApps.builder.previewPublish');
    expect(record).toContain('workspaceApps.record.actionNotice');
    expect(definition).toContain('workspaceApps.definition.advancedHint');
    expect(actions).toContain('workspaceApps.actions.searchPlaceholder');
    expect(table).toContain('workspaceApps.table.empty');
    expect(sidebar).toContain('workspaceApps.connected');
  });

  it('preserves Korean demo status values and Korean template-plan intent matching', () => {
    expect(record).toContain("['상담중', '제안', '계약', '보류', '준비 중']");
    expect(frappe).toContain("prompt.includes('사업자등록번호')");
    expect(frappe).toContain("prompt.includes('승인 흐름')");
  });
});
