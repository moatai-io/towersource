#!/usr/bin/env node
// Read-only inventory for project-local skills across Tower workspace projects.
// It reports canonical skills/, Pi/Agent compatibility folders, and legacy .claude/skills.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(process.env.HOME || '.', 'workspace');
const PROJECTS_DIR = path.join(WORKSPACE_ROOT, 'projects');
const DB_MARKER = '.tower-db-managed';

const SKILL_PATHS = [
  { key: 'canonical', label: 'skills', rel: ['skills'] },
  { key: 'pi', label: '.pi/skills', rel: ['.pi', 'skills'] },
  { key: 'agents', label: '.agents/skills', rel: ['.agents', 'skills'] },
  { key: 'legacyClaude', label: '.claude/skills', rel: ['.claude', 'skills'] },
];

function usage() {
  console.log(`Usage: node scripts/scan-project-skills.mjs [--json] [--project <slug>] [--workspace <path>]\n\nRead-only scan. Does not move, delete, or write files.\n`);
}

function parseArgs(argv) {
  const opts = { json: false, project: null, workspace: WORKSPACE_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--project') opts.project = argv[++i];
    else if (arg === '--workspace') opts.workspace = argv[++i];
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function listProjects(projectsDir, projectFilter) {
  if (!fs.existsSync(projectsDir)) return [];
  return fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !projectFilter || name === projectFilter)
    .sort();
}

function listSkillDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(root, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

function readDescription(skillFile) {
  try {
    const content = fs.readFileSync(skillFile, 'utf8');
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return '';
    const block = fm[1].match(/^description:\s*[|>][^\n]*\n((?:[ \t]+[^\n]*\n?)+)/m);
    if (block) return block[1].replace(/^[ \t]+/gm, '').trim().split('\n')[0];
    const single = fm[1].match(/^description:\s*(.+)$/m);
    if (!single) return '';
    return single[1].trim().replace(/^['"]|['"]$/g, '');
  } catch {
    return '';
  }
}

function scanProject(projectsDir, projectName) {
  const root = path.join(projectsDir, projectName);
  const byName = new Map();

  for (const source of SKILL_PATHS) {
    const sourceRoot = path.join(root, ...source.rel);
    for (const name of listSkillDirs(sourceRoot)) {
      const skillDir = path.join(sourceRoot, name);
      const skillFile = path.join(skillDir, 'SKILL.md');
      const marker = fs.existsSync(path.join(skillDir, DB_MARKER));
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({
        source: source.key,
        label: source.label,
        path: skillDir,
        marker,
        description: readDescription(skillFile),
      });
    }
  }

  const skills = [...byName.entries()].map(([name, locations]) => {
    const hasCanonical = locations.some((loc) => loc.source === 'canonical');
    const hasLegacy = locations.some((loc) => loc.source === 'legacyClaude');
    const hasPi = locations.some((loc) => loc.source === 'pi');
    const hasAgents = locations.some((loc) => loc.source === 'agents');
    const canonicalMarkerOnly = locations.some((loc) => loc.source === 'canonical' && loc.marker)
      && !locations.some((loc) => loc.source === 'canonical' && !loc.marker);

    let recommendation = 'ok';
    if (canonicalMarkerOnly && locations.length === 1) {
      recommendation = 'inert-db-backup: keep unless user requests cleanup';
    } else if (hasCanonical && hasLegacy) {
      recommendation = 'duplicate: canonical skills/ wins; legacy .claude can be reviewed for cleanup';
    } else if (!hasCanonical && hasLegacy) {
      recommendation = 'legacy-only: consider copying to skills/ after review';
    } else if (!hasCanonical && (hasPi || hasAgents)) {
      recommendation = 'compat-only: consider copying to skills/ if this is project-owned';
    }

    return { name, locations, recommendation };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return { project: projectName, root, skills };
}

function printText(report) {
  console.log(`Project skill inventory (read-only)`);
  console.log(`workspace: ${report.workspace}`);
  console.log(`projects scanned: ${report.projects.length}`);
  console.log('');

  let totalSkills = 0;
  let flagged = 0;
  for (const project of report.projects) {
    if (project.skills.length === 0) continue;
    totalSkills += project.skills.length;
    const projectFlagged = project.skills.filter((skill) => skill.recommendation !== 'ok').length;
    flagged += projectFlagged;
    console.log(`## ${project.project}`);
    for (const skill of project.skills) {
      const marker = skill.recommendation === 'ok' ? '' : ` — ${skill.recommendation}`;
      console.log(`- ${skill.name}${marker}`);
      for (const loc of skill.locations) {
        const flags = loc.marker ? ' [db-managed]' : '';
        const desc = loc.description ? ` — ${loc.description}` : '';
        console.log(`  - ${loc.label}${flags}: ${loc.path}${desc}`);
      }
    }
    console.log('');
  }

  console.log(`summary: ${totalSkills} skills, ${flagged} flagged recommendations`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(opts.workspace);
  const projectsDir = path.join(workspace, 'projects');
  const projects = listProjects(projectsDir, opts.project).map((name) => scanProject(projectsDir, name));
  const report = { workspace, projects };

  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else printText(report);
}

try {
  main();
} catch (err) {
  console.error(err?.message || String(err));
  process.exit(1);
}
