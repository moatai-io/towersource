/**
 * Owns: Project-local Workspace Apps definition discovery. Public API: loadWorkspaceAppDefinitions().
 * See README.md.
 */

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { WorkspaceAppDefinitionSchema, type WorkspaceAppDefinition } from './app-definition-schema.js';

const APPS_DIR = 'apps';
const MAX_APP_DIRS = 80;
const MAX_DEFINITION_BYTES = 512 * 1024;
const DEFINITION_FILE_NAMES = new Set(['app.yaml', 'app.yml', 'app.json']);

function parseDefinitionFile(filePath: string): unknown {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('definition path is not a file');
  if (stat.size > MAX_DEFINITION_BYTES) throw new Error(`definition file exceeds ${MAX_DEFINITION_BYTES} bytes`);
  const raw = fs.readFileSync(filePath, 'utf8');
  return filePath.toLowerCase().endsWith('.json') ? JSON.parse(raw) : YAML.parse(raw);
}

function relativeSourcePath(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, filePath).split(path.sep).join(path.posix.sep);
}

function candidateDefinitionFiles(projectRoot: string): string[] {
  const appsRoot = path.join(projectRoot, APPS_DIR);
  if (!fs.existsSync(appsRoot)) return [];
  const rootReal = fs.realpathSync(projectRoot);
  const appsReal = fs.realpathSync(appsRoot);
  if (!(appsReal === rootReal || appsReal.startsWith(rootReal + path.sep))) return [];

  const entries = fs.readdirSync(appsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(name))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_APP_DIRS);

  const files: string[] = [];
  for (const dirName of entries) {
    const appDir = path.join(appsRoot, dirName);
    let realAppDir: string;
    try { realAppDir = fs.realpathSync(appDir); } catch { continue; }
    if (!(realAppDir === rootReal || realAppDir.startsWith(rootReal + path.sep))) continue;
    for (const fileName of fs.readdirSync(appDir)) {
      if (DEFINITION_FILE_NAMES.has(fileName.toLowerCase())) files.push(path.join(appDir, fileName));
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

export function loadWorkspaceAppDefinitions(projectRoot?: string | null): WorkspaceAppDefinition[] {
  if (!projectRoot) return [];
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root)) return [];

  const definitions: WorkspaceAppDefinition[] = [];
  for (const filePath of candidateDefinitionFiles(root)) {
    try {
      const parsed = WorkspaceAppDefinitionSchema.parse(parseDefinitionFile(filePath));
      definitions.push({ ...parsed, sourcePath: relativeSourcePath(root, filePath) });
    } catch (err: any) {
      console.warn(`[workspace-apps] skipping invalid definition ${filePath}: ${err?.message || err}`);
    }
  }
  return definitions;
}
