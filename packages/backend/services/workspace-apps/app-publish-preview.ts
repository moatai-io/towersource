/**
 * Owns: Workspace Apps publish preview intent generation. Public API: previewWorkspaceAppDraftPublish().
 * See README.md.
 */

import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import type { WorkspaceAppDraftRecord } from './app-draft-store.js';
import type { WorkspaceAppBuilderDraftChange, WorkspaceAppDefinition } from './app-definition-schema.js';

const MAX_SOURCE_BYTES = 512 * 1024;

export interface WorkspaceAppPublishPreview {
  appId: string;
  draftId: string;
  sourcePath: string;
  beforeHash: string;
  afterHash: string;
  previewHash: string;
  changes: WorkspaceAppDraftRecord['draftPreview']['changes'];
  beforeText: string;
  afterText: string;
}

export interface WorkspaceAppPublishResult {
  id: string;
  appId: string;
  draftId: string;
  sourcePath: string;
  beforeHash: string;
  afterHash: string;
  previewHash: string;
  actorUserId: number;
  publishedAt: string;
  status: 'published';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function resolveSourceFile(projectRoot: string, sourcePath?: string): string {
  if (!sourcePath || path.isAbsolute(sourcePath)) throw new Error('workspace app definition has no project-relative sourcePath');
  const normalized = path.normalize(sourcePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) throw new Error('workspace app sourcePath escapes project root');
  if (!/apps[\/][a-z0-9][a-z0-9_-]{0,79}[\/]app\.(ya?ml|json)$/i.test(normalized)) {
    throw new Error('workspace app sourcePath must be apps/<app>/app.yaml|app.yml|app.json');
  }
  const rootReal = fs.realpathSync(projectRoot);
  const resolved = path.resolve(rootReal, normalized);
  const real = fs.realpathSync(resolved);
  if (!(real === rootReal || real.startsWith(rootReal + path.sep))) throw new Error('workspace app sourcePath escapes project root');
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error('workspace app sourcePath is not a file');
  if (stat.size > MAX_SOURCE_BYTES) throw new Error('workspace app definition is too large');
  return real;
}

function cloneDefinitionObject(value: unknown): any {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function applyPublishPreviewChange(target: any, change: WorkspaceAppBuilderDraftChange): void {
  if (change.path === 'title') {
    target.title = change.after;
    return;
  }
  if (change.path === 'description') {
    target.description = change.after;
    return;
  }
  if (change.path === 'tableView.title') {
    target.tableView = { ...(target.tableView ?? {}), title: change.after };
    return;
  }
  if (change.path === 'tableView.subtitle') {
    target.tableView = { ...(target.tableView ?? {}), subtitle: change.after };
    return;
  }
  const columnLabelMatch = change.path.match(/^tableView\.columns\[(\d+)\]\.label$/);
  if (columnLabelMatch) {
    const columnIndex = Number(columnLabelMatch[1]);
    const columns = Array.isArray(target.tableView?.columns) ? [...target.tableView.columns] : [];
    if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= columns.length) return;
    columns[columnIndex] = { ...columns[columnIndex], label: change.after };
    target.tableView = { ...(target.tableView ?? {}), columns };
  }
}

function parseSource(sourcePath: string, raw: string): any {
  return sourcePath.toLowerCase().endsWith('.json') ? JSON.parse(raw) : YAML.parse(raw);
}

function stringifySource(sourcePath: string, value: any): string {
  if (sourcePath.toLowerCase().endsWith('.json')) return `${JSON.stringify(value, null, 2)}\n`;
  return YAML.stringify(value, { lineWidth: 120 });
}

function atomicWriteFile(targetPath: string, content: string): void {
  const tmpPath = `${targetPath}.workspace-apps-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o640 });
  fs.renameSync(tmpPath, targetPath);
}

function writePublishRecord(projectRoot: string, result: WorkspaceAppPublishResult): void {
  const rootReal = fs.realpathSync(projectRoot);
  const dir = path.resolve(rootReal, '.workspace-apps', 'publishes', result.appId);
  fs.mkdirSync(dir, { recursive: true });
  const dirReal = fs.realpathSync(dir);
  if (!(dirReal === rootReal || dirReal.startsWith(rootReal + path.sep))) throw new Error('workspace app publish record path escapes project root');
  fs.writeFileSync(path.join(dirReal, `${result.id}.json`), `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o640 });
}

export function previewWorkspaceAppDraftPublish(input: {
  projectRoot: string;
  definition: WorkspaceAppDefinition;
  draft: WorkspaceAppDraftRecord;
}): WorkspaceAppPublishPreview {
  if (input.definition.id !== input.draft.appId) throw new Error('draft does not belong to this workspace app');
  const sourceFile = resolveSourceFile(input.projectRoot, input.definition.sourcePath);
  const beforeText = fs.readFileSync(sourceFile, 'utf8');
  const parsed = parseSource(sourceFile, beforeText);
  const afterObject = cloneDefinitionObject(parsed);
  for (const change of input.draft.draftPreview.changes) applyPublishPreviewChange(afterObject, change);
  const afterText = stringifySource(sourceFile, afterObject);
  const beforeHash = sha256(beforeText);
  const afterHash = sha256(afterText);
  const previewHash = sha256(JSON.stringify({ appId: input.definition.id, draftId: input.draft.id, beforeHash, afterHash, changes: input.draft.draftPreview.changes }));
  return {
    appId: input.definition.id,
    draftId: input.draft.id,
    sourcePath: input.definition.sourcePath!,
    beforeHash,
    afterHash,
    previewHash,
    changes: input.draft.draftPreview.changes,
    beforeText,
    afterText,
  };
}

export function applyWorkspaceAppDraftPublish(input: {
  projectRoot: string;
  definition: WorkspaceAppDefinition;
  draft: WorkspaceAppDraftRecord;
  actorUserId: number;
  confirmed: boolean;
  expectedBeforeHash: string;
  previewHash: string;
  now?: Date;
}): WorkspaceAppPublishResult {
  if (input.confirmed !== true) throw new Error('workspace app publish requires explicit confirmation');
  const preview = previewWorkspaceAppDraftPublish(input);
  if (preview.beforeHash !== input.expectedBeforeHash) throw new Error('workspace app publish preview is stale');
  if (preview.previewHash !== input.previewHash) throw new Error('workspace app publish hash mismatch');
  const sourceFile = resolveSourceFile(input.projectRoot, input.definition.sourcePath);
  atomicWriteFile(sourceFile, preview.afterText);
  const result: WorkspaceAppPublishResult = {
    id: randomUUID(),
    appId: preview.appId,
    draftId: preview.draftId,
    sourcePath: preview.sourcePath,
    beforeHash: preview.beforeHash,
    afterHash: preview.afterHash,
    previewHash: preview.previewHash,
    actorUserId: input.actorUserId,
    publishedAt: (input.now ?? new Date()).toISOString(),
    status: 'published',
  };
  writePublishRecord(input.projectRoot, result);
  return result;
}
