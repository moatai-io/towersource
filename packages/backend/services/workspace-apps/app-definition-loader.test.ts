import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkspaceAppDefinitions } from './app-definition-loader.js';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-workspace-apps-'));
});

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function writeAppYaml(appId: string, yaml: string) {
  const dir = path.join(root, 'apps', appId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'app.yaml'), yaml, 'utf8');
}

describe('loadWorkspaceAppDefinitions', () => {
  it('loads validated app.yaml definitions under the project apps directory', () => {
    writeAppYaml('sales-ops', `
id: sales-ops
name: Sales Ops
eyebrow: 업무 앱 · Connector metadata
title: 업무 앱
description: File-backed definition
source:
  provider: sqlite
  databasePath: apps/sales-ops/data.sqlite
queries:
  - id: accounts
    label: Accounts
    mode: read
    sql: SELECT name FROM accounts
menu:
  - id: dashboard
    label: 대시보드
    live: true
metrics:
  - id: monthly-invoice
    label: 이번 달 청구
    value: ₩42.8M
    delta: +18%
    tone: primary
tableView:
  id: customer-ops
  title: 거래처 운영 현황
  subtitle: metadata hot reload 대상 화면
  statusLabel: Preview-ready
  columns:
    - key: name
      label: 거래처
      kind: text
  rows:
    - name: DemoOrg
builder:
  title: Admin builder
  description: Preview and publish flow
  steps:
    - id: connect-neon
      label: Neon connection 등록
`);

    expect(loadWorkspaceAppDefinitions(root)).toEqual([
      expect.objectContaining({
        id: 'sales-ops',
        title: '업무 앱',
        sourcePath: 'apps/sales-ops/app.yaml',
        source: expect.objectContaining({ provider: 'sqlite', databasePath: 'apps/sales-ops/data.sqlite' }),
        queries: [expect.objectContaining({ id: 'accounts', mode: 'read' })],
        tableView: expect.objectContaining({ rows: [{ name: 'DemoOrg' }] }),
      }),
    ]);
  });

  it('skips invalid definitions without failing the whole apps surface', () => {
    writeAppYaml('broken', 'id: not valid\nname: Broken');
    writeAppYaml('valid', `
id: valid
name: Valid
title: Valid App
menu:
  - id: dashboard
    label: Dashboard
tableView:
  id: main
  title: Main
  columns:
    - key: name
      label: Name
`);

    expect(loadWorkspaceAppDefinitions(root).map((app) => app.id)).toEqual(['valid']);
  });
});
