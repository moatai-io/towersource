import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceAppDefinition } from './app-definition-schema.js';
import { executeWorkspaceAppAction } from './app-action-executor.js';
import { runWorkspaceAppSqliteReadOnlyQuery } from './sqlite-connection.js';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-workspace-apps-actions-'));
  fs.mkdirSync(path.join(root, 'apps', 'sales-ops'), { recursive: true });
  const dbPath = path.join(root, 'apps/sales-ops/data.sqlite');
  const seed = `
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL,
  amount TEXT NOT NULL,
  due TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 99
);
INSERT INTO accounts (name, owner, status, amount, due, sort_order) VALUES ('DemoOrg', 'Julius', '상담중', '₩12.4M', 'D-12', 1);
`;
  const child = spawnSync('sqlite3', [dbPath], { input: seed, encoding: 'utf8' });
  if (child.status !== 0) throw new Error(child.stderr || 'sqlite seed failed');
});

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function definition(): WorkspaceAppDefinition {
  return {
    id: 'sales-ops',
    name: 'Sales Ops',
    eyebrow: 'Workspace Apps',
    title: '영업 업무',
    description: '',
    primaryActionLabel: '신규 등록',
    secondaryActionLabel: '관리자 설정',
    menuTitle: '업무 메뉴',
    source: { provider: 'sqlite', databasePath: 'apps/sales-ops/data.sqlite', schema: 'public' },
    menu: [{ id: 'accounts', label: '거래처', live: true }],
    metrics: [],
    record: { id: 'customer', label: '고객사', table: 'accounts', primaryKey: 'id' },
    fields: [
      { id: 'name', label: '고객사', type: 'text', required: true },
      { id: 'owner', label: '담당자', type: 'text' },
      { id: 'status', label: '상태', type: 'status', options: ['상담중', '제안', '계약', '보류'] },
      { id: 'amount', label: '금액', type: 'money' },
      { id: 'due', label: '기한', type: 'date' },
    ],
    actions: [
      { id: 'create-customer', label: '신규 등록', type: 'create' },
      { id: 'update-customer', label: '선택 수정', type: 'update' },
      { id: 'change-customer-status', label: '상태 변경', type: 'change-status', field: 'status' },
    ],
    queries: [],
    tableView: {
      id: 'customer-ops',
      title: '거래처 운영 현황',
      subtitle: '',
      statusLabel: 'SQLite',
      columns: [{ key: 'name', label: '거래처', kind: 'text' }],
      rows: [],
    },
    builder: { title: '화면 변경', description: '', steps: [] },
  };
}

async function rows() {
  return runWorkspaceAppSqliteReadOnlyQuery({
    projectRoot: root,
    databasePath: 'apps/sales-ops/data.sqlite',
    sql: 'SELECT id, name, owner, status, amount, due FROM accounts ORDER BY id',
  });
}

describe('Workspace Apps action executor', () => {
  it('executes registered create actions and writes a receipt inside the project', async () => {
    const receipt = await executeWorkspaceAppAction({
      projectRoot: root,
      projectId: 'project-1',
      definition: definition(),
      actionId: 'create-customer',
      actorUserId: 1,
      payload: { values: { name: 'New Co', owner: 'Ops', status: '제안', amount: '₩1.0M', due: 'D-30' } },
    });
    expect(receipt.actionType).toBe('create');
    expect(receipt.changedFields).toContain('name');
    const result = await rows();
    expect(result.rows.at(-1)?.name).toBe('New Co');
    expect(fs.existsSync(path.join(root, '.workspace-apps/actions/sales-ops', `${receipt.id}.json`))).toBe(true);
  });

  it('executes update and change-status actions only for registered fields/options', async () => {
    await executeWorkspaceAppAction({
      projectRoot: root,
      projectId: 'project-1',
      definition: definition(),
      actionId: 'update-customer',
      actorUserId: 1,
      payload: { recordId: 1, values: { owner: 'New Owner' } },
    });
    await executeWorkspaceAppAction({
      projectRoot: root,
      projectId: 'project-1',
      definition: definition(),
      actionId: 'change-customer-status',
      actorUserId: 1,
      payload: { recordId: 1, values: { status: '계약' } },
    });
    const result = await rows();
    expect(result.rows[0].owner).toBe('New Owner');
    expect(result.rows[0].status).toBe('계약');
  });

  it('rejects unregistered actions, unregistered fields, and unsupported options', async () => {
    await expect(executeWorkspaceAppAction({
      projectRoot: root,
      projectId: 'project-1',
      definition: definition(),
      actionId: 'delete-customer',
      actorUserId: 1,
      payload: { recordId: 1, values: {} },
    })).rejects.toThrow('not registered');
    await expect(executeWorkspaceAppAction({
      projectRoot: root,
      projectId: 'project-1',
      definition: definition(),
      actionId: 'update-customer',
      actorUserId: 1,
      payload: { recordId: 1, values: { hacked: 'yes' } },
    })).rejects.toThrow('field is not registered');
    await expect(executeWorkspaceAppAction({
      projectRoot: root,
      projectId: 'project-1',
      definition: definition(),
      actionId: 'change-customer-status',
      actorUserId: 1,
      payload: { recordId: 1, values: { status: '삭제' } },
    })).rejects.toThrow('unsupported option');
  });
});
