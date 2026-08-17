#!/usr/bin/env tsx
/**
 * Materialize teamskills/default skills into project-local `.tower/skills` folders.
 *
 * Usage:
 *   npx tsx packages/backend/scripts/materialize-managed-skills.ts --all-projects
 *   npx tsx packages/backend/scripts/materialize-managed-skills.ts --project <id-or-name>
 *   npx tsx packages/backend/scripts/materialize-managed-skills.ts --project-root /path/to/project
 *
 * Defaults to teamskills/skillset.json unless --skills comma,separated,names is provided.
 * Falls back to DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS only for bootstrap/test compatibility.
 */
import os from 'os';
import path from 'path';
import { config, DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS } from '../config.js';
import { closePgPool } from '../db/pg.js';
import { validateTeamskillsSkillset } from '../services/skill/teamskills-source.js';
import { query } from '../db/pg-repo.js';
import { materializeProjectRegistrySkills } from '../services/skill/project-skill-materializer.js';

let jsonOutputMode = false;
let defaultSkillsetWarnings: string[] = [];

interface ProjectRow {
  id: string;
  name: string;
  root_path: string | null;
}

interface TargetProject {
  id?: string;
  name: string;
  rootPath: string;
}

type CliMaterializeResult =
  | {
      project: string;
      id?: string;
      rootPath: string;
      ok: true;
      materialized: number;
      skipped: Array<{ name: string; reason: string }>;
      pruned: string[];
      manifestPath: string;
    }
  | {
      project: string;
      id?: string;
      rootPath: string;
      ok: false;
      error: string;
    };

interface CliOptions {
  allProjects: boolean;
  projectSelectors: string[];
  projectRoots: string[];
  skillNames: string[];
  prune: boolean;
  includeHidden: boolean;
  json: boolean;
  storageMode: 'auto' | 'copy' | 'bind-ro';
}

function parseArgs(argv: string[]): CliOptions {
  const skillset = validateTeamskillsSkillset(DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS);
  defaultSkillsetWarnings = skillset.warnings;
  const opts: CliOptions = {
    allProjects: false,
    projectSelectors: [],
    projectRoots: [],
    skillNames: skillset.skills,
    prune: true,
    includeHidden: false,
    json: false,
    storageMode: 'bind-ro',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--all-projects':
        opts.allProjects = true;
        break;
      case '--project':
        opts.projectSelectors.push(requireValue(argv, ++i, arg));
        break;
      case '--project-root':
        opts.projectRoots.push(requireValue(argv, ++i, arg));
        break;
      case '--skills':
        opts.skillNames = parseCsv(requireValue(argv, ++i, arg));
        break;
      case '--no-prune':
        opts.prune = false;
        break;
      case '--include-hidden':
        opts.includeHidden = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--storage-mode': {
        const value = requireValue(argv, ++i, arg);
        if (value !== 'auto' && value !== 'copy' && value !== 'bind-ro') {
          throw new Error('--storage-mode must be auto, copy, or bind-ro');
        }
        opts.storageMode = value;
        break;
      }
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!opts.allProjects && opts.projectSelectors.length === 0 && opts.projectRoots.length === 0) {
    throw new Error('Choose one target: --all-projects, --project <id-or-name>, or --project-root <path>');
  }
  if (opts.skillNames.length === 0) {
    throw new Error('Skill list is empty');
  }
  return opts;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseCsv(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function printHelp(): void {
  console.log(`Materialize teamskills/default skills into project .tower/skills folders.\n\nOptions:\n  --all-projects              Materialize into every registered project\n  --project <id-or-name>      Materialize into one registered project (repeatable)\n  --project-root <path>       Materialize into an explicit project folder (repeatable)\n  --skills <csv>              Override skill list (default: teamskills/skillset.json)\n  --storage-mode <mode>       bind-ro (default), copy, or auto (alias of bind-ro)\n  --no-prune                  Do not remove previously managed unrequested skills\n  --include-hidden            Allow hidden registry skills (operator diagnostics only)\n  --json                      Print machine-readable JSON\n  --help                      Show this help\n`);
}

async function loadTargets(opts: CliOptions): Promise<TargetProject[]> {
  const targets: TargetProject[] = [];
  const bySelector = new Set(opts.projectSelectors);

  if (opts.allProjects || bySelector.size > 0) {
    const rows = await query<ProjectRow>('SELECT id, name, root_path FROM projects ORDER BY created_at, name');
    for (const row of rows) {
      if (!opts.allProjects && !bySelector.has(row.id) && !bySelector.has(row.name)) continue;
      targets.push({ id: row.id, name: row.name, rootPath: projectRootFor(row) });
      bySelector.delete(row.id);
      bySelector.delete(row.name);
    }
  }

  for (const missing of bySelector) {
    throw new Error(`Project not found: ${missing}`);
  }

  for (const projectRoot of opts.projectRoots) {
    targets.push({ name: path.basename(projectRoot), rootPath: path.resolve(projectRoot) });
  }

  return dedupeTargets(targets);
}

function projectRootFor(row: ProjectRow): string {
  if (row.root_path) return row.root_path;
  const workspaceRoot = process.env.WORKSPACE_ROOT || path.join(os.homedir(), 'workspace');
  return path.join(workspaceRoot, 'projects', row.name);
}

function dedupeTargets(targets: TargetProject[]): TargetProject[] {
  const seen = new Set<string>();
  const out: TargetProject[] = [];
  for (const target of targets) {
    const key = path.resolve(target.rootPath);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  jsonOutputMode = opts.json;
  const targets = await loadTargets(opts);
  const results: CliMaterializeResult[] = [];

  for (const target of targets) {
    try {
      const storageMode = opts.storageMode === 'copy' ? 'copy' : 'bind-ro';
      const result = materializeProjectRegistrySkills({
        projectRootPath: target.rootPath,
        skillNames: opts.skillNames,
        prune: opts.prune,
        includeHidden: opts.includeHidden,
        storageMode,
      });
      results.push({
        project: target.name,
        id: target.id,
        rootPath: target.rootPath,
        ok: true,
        materialized: result.materialized.length,
        skipped: result.skipped,
        pruned: result.pruned,
        manifestPath: result.manifestPath,
      });
    } catch (err) {
      results.push({
        project: target.name,
        id: target.id,
        rootPath: target.rootPath,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const summary = {
    targets: targets.length,
    ok: results.filter((r) => r.ok).length,
    fail: results.filter((r) => !r.ok).length,
    skillCount: opts.skillNames.length,
    prune: opts.prune,
    storageMode: opts.storageMode,
  };

  if (opts.json) {
    console.log(JSON.stringify({ summary, skills: opts.skillNames, skillsetWarnings: defaultSkillsetWarnings, results }, null, 2));
  } else {
    for (const warning of defaultSkillsetWarnings) console.warn(`[skills:materialize] ${warning}`);
    console.log(`Skill materialization: targets=${summary.targets} ok=${summary.ok} fail=${summary.fail} skills=${summary.skillCount} prune=${summary.prune} storage=${summary.storageMode}`);
    for (const result of results) {
      if (!result.ok) {
        console.log(`  ✗ ${result.project}: ${result.error}`);
        continue;
      }
      const skipped = result.skipped.length ? ` skipped=${result.skipped.map((s) => `${s.name}:${s.reason}`).join(',')}` : '';
      const pruned = result.pruned.length ? ` pruned=${result.pruned.join(',')}` : '';
      console.log(`  ✓ ${result.project}: materialized=${result.materialized}${skipped}${pruned}`);
    }
  }

  await broadcastSkillsChanged({
    skillNames: opts.skillNames,
    targets: summary.targets,
    ok: summary.ok,
    fail: summary.fail,
  });

  if (summary.fail > 0 || results.some((r) => r.ok && r.skipped.length > 0)) {
    process.exitCode = 1;
  }
}

async function broadcastSkillsChanged(summary: { skillNames: string[]; targets: number; ok: number; fail: number }): Promise<void> {
  try {
    await query('SELECT pg_notify($1, $2)', [
      'tower_ws_events',
      JSON.stringify({
        origin: config.serverEpoch,
        scope: 'all',
        data: {
          type: 'skills_changed',
          reason: 'materialize-managed-skills',
          skillNames: summary.skillNames,
          targets: summary.targets,
          ok: summary.ok,
          fail: summary.fail,
          timestamp: new Date().toISOString(),
        },
      }),
    ]);
  } catch (err) {
    if (!jsonOutputMode) console.warn(`[skills:materialize] skills_changed broadcast skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (!jsonOutputMode) {
      await closePgPool().catch(() => {});
      return;
    }

    const originalLog = console.log;
    console.log = () => {};
    try {
      await closePgPool().catch(() => {});
    } finally {
      console.log = originalLog;
    }
  });
