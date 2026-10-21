/**
 * Skill Registry — project skill management plus managed/library compatibility.
 *
 * 2026-06-10 decision:
 *  - User-facing skill truth is project-scoped: managed `.tower/skills` plus project `skills/`.
 *  - DB-backed personal/project skills are deprecated/legacy-inert and must not appear
 *    in slash commands, session skill prompts, Pi additionalSkillPaths, or new create/copy flows.
 *
 * 2026-06-26 update:
 *  - company/default skill catalog is `workspace/projects/teamskills/skillset.json`.
 *  - per-skill metadata/body live in `workspace/projects/teamskills/skills/<name>`.
 *  - legacy Tower managed/library YAML is compatibility fallback only.
 */
import fs from 'fs';
import path from 'path';
import { query, queryOne, execute } from '../../db/pg-repo.js';
import { config } from '../../config.js';
import { resolveSessionProjectRoot } from '../pm/project-access.js';
import type { SkillMeta, SkillScope, SkillVisibility } from '@tower/shared';
import {
  syncSkillProviders,
  reconcileSkillProviders,
} from './skill-credential.js';
import {
  loadLibrarySkills,
  getLibrarySkill,
  getLibrarySkillDirs,
  getLibrarySkillsDir,
} from './library-skills.js';
import type { LibrarySkill } from './library-skills.js';
import { getTeamskillsProjectRoot, getTeamskillsSkillRoot, readTeamskillsSkillset } from './teamskills-source.js';
import { resolveRegistrySkillBundle } from './skill-bundle-resolver.js';
import type { RegistrySkillBundle } from './skill-bundle-resolver.js';
import { loadWorkflowCommandEntries, nativeCommandEntries, skillCommandEntry, type CommandEntry } from '../command-registry.js';

// ── Filesystem layout ──
const DATA_SKILLS_DIR = path.join(config.dataDir, 'skills');
const RUNTIME_SKILLS_DIR = path.join(config.dataDir, 'runtime-skills');
const SYSTEM_SKILL_SOURCE_DIR = process.env.TOWER_SYSTEM_SKILLS_DIR || path.resolve(config.dataDir, '..', 'skills', 'system');
const DB_MANAGED_SKILL_MARKER = '.tower-db-managed';
const PROJECT_FS_ID_PREFIX = 'project-fs:';

// ═══════════════════════════════════════════════════════════════
// Library (company) skill provider bootstrap
// ═══════════════════════════════════════════════════════════════

/**
 * Seed `skill_providers` for library (company) skills on startup.
 *
 * library.yaml → parse each SKILL.md frontmatter `providers:` block → upsert
 * into `skill_providers` keyed by skill_name. Then cleanup orphan rows whose
 * skill_name no longer exists in library or DB.
 *
 * Safe to call on every startup — it only inserts/updates/prunes provider
 * metadata; the skill content itself is never written back to disk.
 */
export async function bootstrapLibraryProviders(): Promise<{ synced: number; orphansRemoved: number }> {
  const library = loadLibrarySkills();

  let synced = 0;
  for (const skill of library) {
    await syncSkillProviders(skill.name, skill.content);
    synced++;
  }

  // DB-backed project/personal skills are legacy-inert. Provider metadata for
  // user-facing skills is derived from library/managed sources and project files.
  const active = new Set<string>([
    ...library.map(s => s.name),
  ]);

  const orphansRemoved = await reconcileSkillProviders(active);

  console.log(
    `[skills] bootstrapLibraryProviders: library=${library.length}, ` +
    `providers_synced=${synced}, orphans_removed=${orphansRemoved}`,
  );
  return { synced, orphansRemoved };
}

// ═══════════════════════════════════════════════════════════════
// Legacy sync compatibility no-ops
// ═══════════════════════════════════════════════════════════════

/**
 * Deprecated no-op. Project skills are file-backed under
 * `projects/<project>/skills/<name>/SKILL.md`; DB-backed project materialization
 * is legacy-inert and must not create new `.tower-db-managed` outputs.
 */
export async function syncProjectSkillsToFs(_projectId: string, _projectRootPath: string): Promise<void> {
  return;
}

/** Deprecated: personal skills are legacy-inert and no longer materialized. */
export async function syncPersonalSkillsToFs(_userId: number): Promise<void> {
  return;
}

// ═══════════════════════════════════════════════════════════════
// CRUD — project filesystem only (company read-only from managed catalog; personal deprecated)
// ═══════════════════════════════════════════════════════════════

/**
 * List skills visible to a user. Merges:
 *  - company scope → teamskills/skillset.json + teamskills/skills/<name>
 *  - project scope → file-backed project skills from the project root
 *
 * DB-backed personal/project skills are deprecated and intentionally hidden from
 * user-facing lists.
 */
export async function listSkills(scope?: SkillScope, projectId?: string, userId?: number, username?: string | null): Promise<SkillMeta[]> {
  const results: SkillMeta[] = [];

  // Company skills: teamskills is the catalog. Legacy library YAML is no longer
  // the user-facing source for ordinary shared skills.
  if (!scope || scope === 'company') {
    for (const meta of loadTeamskillsCatalogMetas(username)) {
      results.push(meta);
    }
  }

  // DB-backed personal/project skills are legacy-inert. Project skills are
  // listed from filesystem sources below; DB rows are migration candidates only.
  if (scope === 'personal') return results;

  // Project-native filesystem skills (`projects/<project>/skills`) are listed
  // when a project context is available.
  if ((!scope || scope === 'project') && projectId) {
    const projectRoot = await resolveProjectRootPath(projectId);
    const seen = new Set(results.map((s) => s.name));
    for (const s of loadProjectFilesystemSkills(projectRoot ?? undefined)) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      results.push(s);
    }
  }

  // Attach per-user pref if userId provided
  if (userId) {
    const userPrefs = await getUserSkillPrefs(userId);
    for (const meta of results) {
      const pref = userPrefs.get(meta.name);
      meta.userEnabled = pref ?? null;
    }
  }
  return results;
}

/**
 * Get a single skill by id (UUID for project) or name (library).
 * Returns content embedded in the result.
 */
export async function getSkill(idOrName: string): Promise<(SkillMeta & { content: string }) | null> {
  const teamskills = getTeamskillsSkillByName(idOrName);
  if (teamskills) return teamskills;

  // Legacy library fallback for migration/operator screens only.
  const lib = getLibrarySkill(idOrName);
  if (lib) {
    return { ...librarySkillToMeta(lib), content: lib.content } as SkillMeta & { content: string };
  }

  // Project filesystem skill (path-based synthetic ID)
  const projectFs = getProjectFilesystemSkillById(idOrName);
  if (projectFs) return projectFs;

  // DB (UUID-based) — legacy lookup for migration/edit screens only.
  const row = await queryOne('SELECT * FROM skill_registry WHERE id = $1', [idOrName]);
  return row ? { ...rowToMeta(row), content: row.content } : null;
}

export interface SkillRegistryDoctorResult {
  skillName: string;
  registry: {
    disk: { exists: boolean; path: string | null };
    registered: boolean;
    catalog: 'system' | 'local' | 'db' | null;
    ownership: 'system' | 'vm-local' | 'personal' | 'project' | null;
    visibility: 'private' | 'public' | 'default' | 'hidden' | null;
    enabledForMe: boolean | null;
    promptCandidate: boolean;
    source: string | null;
  };
  runtime: {
    hostBashAvailable: boolean;
    sandboxRunAvailable: boolean;
    sandboxPersistentAvailable: boolean;
    publishingAvailable: boolean;
    networkPolicy: string;
    secretGrants: 'runtime-managed';
    projectBoundary: string;
    requirements?: SkillMeta['runtimeRequirements'];
  };
  portability: {
    status: 'PASS' | 'WARN' | 'OPS-EXEMPT' | 'UNKNOWN';
    level?: string;
    warnings: string[];
  };
  diagnosis: string;
  nextFix: string;
}

const TOWER_OPS_SKILL_NAMES = new Set(['fleet', 'library', 'selfheal', 'tower-guide-update', 'skill-registry', 'skill-registry-orchestration']);

function findSkillDiskPath(name: string): string | null {
  const candidates = [
    ...getLibrarySkillDirs().map((dir) => path.join(dir, name, 'SKILL.md')),
    path.join(DATA_SKILLS_DIR, 'company', name, 'SKILL.md'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function runtimeCapabilitySnapshot(requirements?: SkillMeta['runtimeRequirements']): SkillRegistryDoctorResult['runtime'] {
  return {
    hostBashAvailable: true,
    sandboxRunAvailable: !!config.sandbox?.enabled,
    sandboxPersistentAvailable: !!config.sandbox?.enabled,
    publishingAvailable: true,
    networkPolicy: config.sandbox?.enabled ? 'sandbox default-deny; allow_outbound enables Tier-1 whitelist' : 'sandbox unavailable in this runtime',
    secretGrants: 'runtime-managed',
    projectBoundary: 'enforced by Tower workspace/project guards',
    requirements,
  };
}

function portabilityStatus(meta: SkillMeta | null): SkillRegistryDoctorResult['portability'] {
  const level = meta?.portability?.level;
  const warnings = meta?.portability?.warnings ?? [];
  if (level === 'tower-ops-only' || (meta && TOWER_OPS_SKILL_NAMES.has(meta.name))) {
    return { status: 'OPS-EXEMPT', level, warnings };
  }
  if (!meta) return { status: 'UNKNOWN', warnings: [] };
  return { status: warnings.length > 0 ? 'WARN' : 'PASS', level, warnings };
}

function promptCandidateForMeta(meta: SkillMeta, userPref: boolean | null): boolean {
  if (!meta.enabled) return false;
  if (meta.visibility === 'hidden') return false;
  if (meta.visibility === 'public' || meta.visibility === 'private') return userPref === true;
  return userPref !== false;
}

/**
 * Registry doctor separates visibility/registration problems from runtime capability problems.
 * It is intentionally diagnostic-only: no visibility or execution fallback changes happen here.
 */
export async function getSkillRegistryDoctor(skillNameOrId: string, userId?: number, projectId?: string | null): Promise<SkillRegistryDoctorResult> {
  const skill = await getSkill(skillNameOrId);
  const resolvedName = skill?.name ?? skillNameOrId;
  const diskPath = findSkillDiskPath(resolvedName);

  let dbMeta: SkillMeta | null = null;
  if (!skill) {
    const params: any[] = [resolvedName];
    let sql = `SELECT * FROM skill_registry WHERE name = $1 AND scope = 'project'`;
    if (projectId) { sql += ` AND project_id = $${params.length + 1}`; params.push(projectId); }
    sql += ` ORDER BY name LIMIT 1`;
    const row = await queryOne<any>(sql, params);
    dbMeta = row ? rowToMeta(row) : null;
  }

  const meta = skill ?? dbMeta;
  const userPref = userId && meta ? await getUserSkillPref(userId, meta.name) : null;
  const promptCandidate = meta ? promptCandidateForMeta(meta, userPref) : false;
  const runtime = runtimeCapabilitySnapshot(meta?.runtimeRequirements);
  const portability = portabilityStatus(meta);

  let diagnosis = 'Registry state looks prompt-eligible; if execution failed, diagnose runtime capability separately.';
  let nextFix = 'No registry fix needed. Check runtime capability if the failure happened during execution.';
  if (!diskPath && !meta) {
    diagnosis = 'Skill folder and registry entry are both missing.';
    nextFix = 'Restore the skill folder or create the skill with /skill-architect.';
  } else if (diskPath && !meta) {
    diagnosis = 'Skill exists on disk but is not registered in a catalog/DB. If it is project-authored under projects/<project>/skills, this is normal; otherwise register/promote it intentionally.';
    nextFix = 'For project-local skills, keep it under projects/<project>/skills. For managed/company skills, register the Tower-owned source/catalog metadata.';
  } else if (meta?.visibility === 'hidden') {
    diagnosis = 'Skill is registered but hidden, so it is excluded from prompt injection.';
    nextFix = 'Change visibility to default, or keep hidden and invoke/enable intentionally if supported.';
  } else if (meta?.visibility === 'public' || meta?.visibility === 'private') {
    diagnosis = 'Skill is registered but not a default prompt candidate for this user.';
    nextFix = 'Enable/copy the skill for this user, or change visibility to default if it should be globally prompt-active.';
  }

  return {
    skillName: resolvedName,
    registry: {
      disk: { exists: !!diskPath, path: diskPath },
      registered: !!meta,
      catalog: meta?.catalog ?? (meta ? 'db' : null),
      ownership: meta?.ownership ?? null,
      visibility: meta?.visibility ?? null,
      enabledForMe: userPref,
      promptCandidate,
      source: meta?.source ?? null,
    },
    runtime,
    portability,
    diagnosis,
    nextFix,
  };
}

/**
 * Create a new project skill as a file-backed project source.
 * Company scope is read-only through this API. Personal scope is deprecated;
 * new user-facing skills must live in a project.
 * Company/org skills are shared into teamskills with share-skill:
 *   workspace/projects/teamskills/skills/<name>/SKILL.md
 * Legacy ~/.claude and tower/skills/managed paths are migration-only, not normal sources.
 */
export async function createSkill(data: {
  name: string;
  scope: SkillScope;
  content: string;
  description?: string;
  category?: string;
  projectId?: string;
  userId?: number;
  visibility?: SkillVisibility;
}): Promise<SkillMeta> {
  if (!['personal', 'project', 'company'].includes(data.scope)) {
    throw new Error(`Invalid skill scope: ${data.scope}`);
  }
  if (data.scope === 'company') {
    throw new Error('Company skills are read-only in the DB API. Use share-skill to update workspace/projects/teamskills/skills/<name>, then materialize selected projects.');
  }
  if (data.scope === 'personal') {
    throw new Error('Personal skills are deprecated. Create a project skill in the current project instead.');
  }
  if (data.scope === 'project' && !data.projectId) {
    throw new Error('projectId required for project skill');
  }
  validateSkillFolderName(data.name);
  const project = await resolveProjectRootPath(data.projectId);
  if (!project) throw new Error('Project root not found for project skill');

  const skillDir = path.join(project, 'skills', data.name);
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillFile)) throw new Error(`Project skill already exists: ${data.name}`);

  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(skillFile, data.content, 'utf-8');

  // Sync providers for this skill (from its frontmatter). Provider metadata is
  // keyed by skill name and remains an index/cache, not the source of truth.
  await syncSkillProviders(data.name, data.content);

  return projectFilesystemSkillToMeta(data.name, skillFile, data.content);
}

/** Deprecated: personal skill snapshots are no longer user-facing. */
export async function copySkillToPersonal(_idOrName: string, _userId: number): Promise<SkillMeta> {
  throw new Error('Personal skills are deprecated. Create or copy the skill into the current project instead.');
}

export async function shareProjectSkillToCompany(id: string): Promise<{ skill: SkillMeta; created: boolean; skillsetUpdated: boolean }> {
  const source = getProjectFilesystemSkillById(id);
  if (!source) throw new Error('Project skill not found');
  if (!source.skillPath) throw new Error('Project skill path missing');
  const projectRoot = resolveSessionProjectRoot(source.skillPath);
  if (!projectRoot) throw new Error('Project skill is not under a project root');
  const rel = path.relative(projectRoot, source.skillPath).split(path.sep).join('/');
  if (!rel.startsWith('skills/')) throw new Error('Only authored project skills under skills/<name>/ can be shared to company catalog');

  validateSkillFolderName(source.name);
  const sourceDir = path.dirname(source.skillPath);
  const targetDir = getTeamskillsSkillRoot(source.name);
  const targetSkillFile = path.join(targetDir, 'SKILL.md');
  let created = false;

  if (fs.existsSync(targetSkillFile)) {
    const existing = fs.readFileSync(targetSkillFile, 'utf-8');
    if (existing !== source.content) {
      throw new Error(`Company skill already exists with different content: ${source.name}`);
    }
  } else {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true, filter: shouldCopySkillSourceFile });
    created = true;
  }

  const skillsetUpdated = addSkillToTeamskillsSkillset(source.name);
  await syncSkillProviders(source.name, source.content);
  const shared = getTeamskillsSkillByName(source.name) ?? teamskillsBundleToMeta({ name: source.name, skillPath: targetSkillFile, visibility: 'default' } as RegistrySkillBundle, source.content);
  return { skill: shared, created, skillsetUpdated };
}

function shouldCopySkillSourceFile(src: string): boolean {
  const base = path.basename(src);
  if (base.startsWith('.')) return false;
  if (['node_modules', 'dist', 'build', '.tower', '.pi', '.runtime-box', '__pycache__'].includes(base)) return false;
  if (/^(?:.*\.)?(?:env|key|pem|p12|pfx|crt|cert|credentials\.json)$/i.test(base)) return false;
  return true;
}

function addSkillToTeamskillsSkillset(name: string): boolean {
  const skillsetPath = path.join(getTeamskillsProjectRoot(), 'skillset.json');
  let parsed: any = { version: 1, defaultSkills: [] };
  try {
    parsed = JSON.parse(fs.readFileSync(skillsetPath, 'utf-8'));
  } catch {}

  if (Array.isArray(parsed)) {
    if (parsed.includes(name)) return false;
    parsed.push(name);
  } else {
    if (!Array.isArray(parsed.defaultSkills)) parsed.defaultSkills = [];
    const exists = parsed.defaultSkills.some((item: any) => typeof item === 'string' ? item === name : item?.name === name);
    if (exists) return false;
    parsed.defaultSkills.push(name);
  }

  fs.mkdirSync(path.dirname(skillsetPath), { recursive: true });
  fs.writeFileSync(skillsetPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
  return true;
}

export async function updateSkill(id: string, data: {
  name?: string;
  content?: string;
  description?: string;
  category?: string;
  enabled?: boolean;
  visibility?: SkillVisibility;
}): Promise<boolean> {
  const fsUpdated = updateProjectFilesystemSkill(id, data);
  if (fsUpdated !== null) return fsUpdated;

  const existing = await queryOne<any>(
    'SELECT scope, project_id, user_id, name FROM skill_registry WHERE id = $1',
    [id],
  );
  if (!existing) return false;
  if (existing.scope === 'company') {
    throw new Error('Company skills are read-only in the DB API. Use share-skill to update workspace/projects/teamskills/skills/<name>, then materialize selected projects.');
  }
  if (existing.scope === 'personal' || existing.scope === 'project') {
    throw new Error('DB-backed personal/project skills are legacy-inert. Create or edit a project file-backed skill under projects/<project>/skills/<name>/SKILL.md instead.');
  }

  const sets: string[] = ['updated_at = CURRENT_TIMESTAMP'];
  const params: any[] = [];
  let idx = 1;

  if (data.name !== undefined) { sets.push(`name = $${idx++}`); params.push(data.name); }
  if (data.content !== undefined) { sets.push(`content = $${idx++}`); params.push(data.content); }
  if (data.description !== undefined) { sets.push(`description = $${idx++}`); params.push(data.description); }
  if (data.category !== undefined) { sets.push(`category = $${idx++}`); params.push(data.category); }
  if (data.visibility !== undefined) { sets.push(`visibility = $${idx++}`); params.push(data.visibility); }
  if (data.enabled !== undefined) { sets.push(`enabled = $${idx++}`); params.push(data.enabled ? 1 : 0); }

  params.push(id);
  await execute(`UPDATE skill_registry SET ${sets.join(', ')} WHERE id = $${idx++}`, params);

  // If content changed, re-sync providers for the skill name
  if (data.content !== undefined) {
    const updatedName = data.name ?? existing.name;
    await syncSkillProviders(updatedName, data.content);
  }

  await syncAfterMutation(existing.scope, existing.project_id, existing.user_id);
  return true;
}

export async function deleteSkill(id: string): Promise<boolean> {
  const fsDeleted = deleteProjectFilesystemSkill(id);
  if (fsDeleted !== null) return fsDeleted;

  const existing = await queryOne<any>(
    'SELECT scope, project_id, user_id, name FROM skill_registry WHERE id = $1',
    [id],
  );
  if (!existing) return false;
  if (existing.scope === 'company') {
    throw new Error('Company skills are read-only in the DB API. Update teamskills/skillset.json or the teamskills source instead.');
  }
  if (existing.scope === 'personal' || existing.scope === 'project') {
    throw new Error('DB-backed personal/project skills are legacy-inert. Archive/migrate them with an explicit migration tool instead of user-facing delete.');
  }

  await execute('DELETE FROM skill_registry WHERE id = $1', [id]);
  // Remove provider rows for this name if nobody else owns the same name
  const remaining = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM skill_registry WHERE name = $1`,
    [existing.name],
  );
  const alsoInLibrary = !!getLibrarySkill(existing.name);
  if ((remaining[0]?.n ?? 0) === 0 && !alsoInLibrary) {
    await execute('DELETE FROM skill_providers WHERE skill_name = $1', [existing.name]);
  }

  await syncAfterMutation(existing.scope, existing.project_id, existing.user_id);
  return true;
}

async function syncAfterMutation(_scope: string, _projectId?: string, _userId?: number) {
  // Legacy DB project/personal rows are no longer materialized to filesystem.
  return;
}

// ═══════════════════════════════════════════════════════════════
// User skill preferences (now keyed by skill_name)
// ═══════════════════════════════════════════════════════════════

/** Set user preference for a skill (overrides global enabled state). */
export async function setUserSkillPref(userId: number, skillName: string, enabled: boolean): Promise<void> {
  await execute(`
    INSERT INTO user_skill_prefs (user_id, skill_name, enabled) VALUES ($1, $2, $3)
    ON CONFLICT (user_id, skill_name) DO UPDATE SET enabled = excluded.enabled
  `, [userId, skillName, enabled ? 1 : 0]);
}

/** Get user preference for a skill. Returns null if no pref set (default = enabled). */
export async function getUserSkillPref(userId: number, skillName: string): Promise<boolean | null> {
  const row = await queryOne<any>(
    'SELECT enabled FROM user_skill_prefs WHERE user_id = $1 AND skill_name = $2',
    [userId, skillName],
  );
  return row ? !!row.enabled : null;
}

/** Get all user prefs as a Map<skillName, enabled> */
async function getUserSkillPrefs(userId: number): Promise<Map<string, boolean>> {
  const rows = await query<any>(
    'SELECT skill_name, enabled FROM user_skill_prefs WHERE user_id = $1',
    [userId],
  );
  const map = new Map<string, boolean>();
  for (const r of rows) map.set(r.skill_name, !!r.enabled);
  return map;
}

/**
 * Merge visibility check: library/DB-native enabled state AND per-user pref.
 * Library skills default to `enabled=true`; DB skills honor the `enabled` column.
 */
function isSkillActiveForUser(enabledInSource: boolean, name: string, userPrefs: Map<string, boolean>): boolean {
  if (!enabledInSource) return false;
  const pref = userPrefs.get(name);
  return pref !== false; // default = enabled (null/true → active, false → inactive)
}

// ═══════════════════════════════════════════════════════════════
// Session / command helpers (library + DB merged)
// ═══════════════════════════════════════════════════════════════

/**
 * Get merged skills for a session: project skills plus managed/library compatibility.
 * Personal skills are deprecated and intentionally excluded.
 *
 * `access` is the prompt/command exposure gate:
 * - missing or `everyone`: any user on this VM
 * - `user:<username>`: that Tower username only
 * `visibility` and user prefs decide auto-injection after access passes.
 */
export async function getSkillsForSession(userId?: number, projectId?: string | null, username?: string | null, cwd?: string): Promise<SkillMeta[]> {
  const userPrefs = userId ? await getUserSkillPrefs(userId) : new Map<string, boolean>();

  const seen = new Set<string>();
  const result: SkillMeta[] = [];

  // First pass: project filesystem skills. Managed manifest-listed `.tower`
  // skills win, then project-authored `skills/`, then compatibility/import paths.
  // DB-backed project rows are legacy-inert and are not prompt/runtime sources.
  const projectRoot = await resolveProjectSkillRoot(cwd, projectId);
  const projectManagedSkillsReady = hasProjectManagedSkillManifest(projectRoot ?? undefined);
  for (const s of loadProjectFilesystemSkills(projectRoot ?? undefined)) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    if (!isSkillActiveForUser(true, s.name, userPrefs)) continue;
    result.push(s);
  }

  // Third pass: legacy/company library. If project managed skills are
  // materialized, `.tower/skills` is the complete managed source set for that
  // project. Do not re-inject global `~/.claude/skills` entries here, otherwise
  // same-name or extra global skills leak back into Pi prompts and slash-command
  // availability.
  if (!projectManagedSkillsReady) {
    const library = loadLibrarySkills();
    for (const s of library) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      if (!isLibrarySkillPromptActive(s, userPrefs, username)) continue;
      result.push(librarySkillToMeta(s));
    }
  }

  return result;
}

/** Get commands for /api/commands endpoint (with fullContent for dropdown). */
export async function getCommandsForUser(userId?: number, projectId?: string | null, username?: string | null, cwd?: string): Promise<CommandEntry[]> {
  const userPrefs = userId ? await getUserSkillPrefs(userId) : new Map<string, boolean>();

  const result: CommandEntry[] = [...nativeCommandEntries()];
  const seen = new Set<string>();
  for (const command of result) {
    seen.add(command.id);
    seen.add(command.canonical);
    for (const alias of command.aliases) seen.add(alias);
  }

  const projectRoot = await resolveProjectSkillRoot(cwd, projectId);
  const projectManagedSkillsReady = hasProjectManagedSkillManifest(projectRoot ?? undefined);
  for (const command of loadWorkflowCommandEntries(projectRoot ?? undefined, 'project')) {
    if (seen.has(command.id) || seen.has(command.canonical)) continue;
    seen.add(command.id);
    seen.add(command.canonical);
    for (const alias of command.aliases) seen.add(alias);
    result.push(command);
  }
  for (const s of loadProjectFilesystemSkills(projectRoot ?? undefined)) {
    const canonical = `/${s.name}`;
    if (seen.has(s.name) || seen.has(canonical)) {
      console.warn(`[commands] skipping conflicting project skill ${s.skillPath || s.name}: ${canonical} is already registered by a command`);
      continue;
    }
    seen.add(s.name);
    seen.add(canonical);
    if (!isSkillActiveForUser(true, s.name, userPrefs)) continue;
    result.push(skillCommandEntry({
      name: s.name,
      description: s.description,
      content: s.content,
      scope: 'project',
    }));
  }

  // Slash-command dropdown must mirror project runtime. Once `.tower/skills` is
  // present, global/company library entries are transport/source compatibility
  // only and must not appear as extra commands in customer project sessions.
  if (!projectManagedSkillsReady) {
    const library = loadLibrarySkills();
    for (const s of library) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      if (!isLibrarySkillPromptActive(s, userPrefs, username)) continue;
      result.push(skillCommandEntry({
        name: s.name,
        description: s.description,
        content: s.content,
        scope: 'company',
      }));
    }
  }

  return result;
}

/** Deprecated: personal skills no longer participate in slash command prepend. */
export async function getPersonalSkill(_userId: number, _name: string): Promise<{ content: string } | null> {
  return null;
}

/** Get skill by name from any scope (for Pi engine prepend fallback). */
export async function getSkillByName(name: string, userId?: number, projectId?: string | null, username?: string | null, cwd?: string): Promise<{ content: string; scope: string } | null> {
  // Priority: project filesystem → library(company). DB project/personal rows are legacy-inert.
  const projectRoot = await resolveProjectSkillRoot(cwd, projectId);
  const projectManagedSkillsReady = hasProjectManagedSkillManifest(projectRoot ?? undefined);
  const fsProject = loadProjectFilesystemSkills(projectRoot ?? undefined).find((s) => s.name === name);
  if (fsProject) {
    logSkillResolution('getSkillByName', {
      skill: name,
      resolutionSource: projectManagedSkillsReady ? 'project-skills+project-manifest' : 'project-skills',
      resolvedSkillPath: fsProject.skillPath,
      scope: 'project',
    });
    return { content: fsProject.content, scope: 'project' };
  }

  if (projectManagedSkillsReady) {
    logSkillResolution('getSkillByName-blocked', {
      skill: name,
      resolutionSource: 'project-skills+project-manifest',
      manifestPath: projectRoot ? path.join(projectRoot, PROJECT_MANAGED_SKILLS_DIR, PROJECT_MANAGED_SKILLS_MANIFEST) : null,
      blockedReason: 'not_in_project_skills_or_manifest',
    }, 'warn');
    return null;
  }

  const lib = getLibrarySkill(name);
  if (lib) {
    const userPrefs = userId ? await getUserSkillPrefs(userId) : new Map<string, boolean>();
    if (!isLibrarySkillPromptActive(lib, userPrefs, username)) {
      logSkillResolution('getSkillByName-blocked', {
        skill: name,
        resolutionSource: 'company-library',
        resolvedSkillPath: lib.skillPath,
        blockedReason: 'library_skill_inactive_or_not_allowed',
      });
      return null;
    }
    logSkillResolution('getSkillByName', {
      skill: name,
      resolutionSource: 'company-library',
      resolvedSkillPath: lib.skillPath,
      scope: 'company',
    });
    return { content: lib.content, scope: 'company' };
  }
  logSkillResolution('getSkillByName-miss', { skill: name, blockedReason: 'not_found' });
  return null;
}

// ═══════════════════════════════════════════════════════════════
// Runtime skill paths (Pi-first materialization adapter)
// ═══════════════════════════════════════════════════════════════

export type SkillRuntime = 'pi' | 'claude';

export interface MaterializedSkillPathOptions {
  /** Target runtime. `pi` is the primary path; `claude` is legacy compatibility. */
  runtime: SkillRuntime;
  userId?: number;
  projectId?: string | null;
  cwd?: string;
  username?: string | null;
}

function copyDirectoryForMaterialization(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== '__pycache__' && !base.endsWith('.pyc');
    },
  });
}

function materializeSystemSkillsForPi(): string | null {
  if (!fs.existsSync(SYSTEM_SKILL_SOURCE_DIR)) return null;

  const targetRoot = path.join(RUNTIME_SKILLS_DIR, 'pi', 'system');
  fs.mkdirSync(targetRoot, { recursive: true });

  const expected = new Set<string>();
  for (const item of fs.readdirSync(SYSTEM_SKILL_SOURCE_DIR, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const sourceSkillDir = path.join(SYSTEM_SKILL_SOURCE_DIR, item.name);
    const sourceSkillFile = path.join(sourceSkillDir, 'SKILL.md');
    if (!fs.existsSync(sourceSkillFile)) continue;
    expected.add(item.name);
    copyDirectoryForMaterialization(sourceSkillDir, path.join(targetRoot, item.name));
  }

  // Remove stale generated skills whose source folder disappeared.
  for (const item of fs.readdirSync(targetRoot, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    if (expected.has(item.name)) continue;
    const maybeSkill = path.join(targetRoot, item.name, 'SKILL.md');
    if (fs.existsSync(maybeSkill)) {
      fs.rmSync(path.join(targetRoot, item.name), { recursive: true, force: true });
    }
  }

  return expected.size > 0 ? targetRoot : null;
}

/** Deprecated: personal skill paths are no longer exposed to runtimes. */
export function getPersonalSkillPaths(_userId?: number): string[] {
  return [];
}

const PROJECT_MANAGED_SKILLS_DIR = path.join('.tower', 'skills');
const PROJECT_MANAGED_SKILLS_MANIFEST = 'manifest.json';
const PROJECT_NATIVE_SKILLS_DIR = 'skills';
const PROJECT_PI_SKILLS_DIR = path.join('.pi', 'skills');
const PROJECT_AGENTS_SKILLS_DIR = path.join('.agents', 'skills');
const PROJECT_LEGACY_CLAUDE_SKILLS_DIR = path.join('.claude', 'skills');

function skillDebugEnabled(): boolean {
  return process.env.TOWER_DEBUG_SKILLS === '1' || process.env.TOWER_DEBUG_SKILLS === 'true';
}

function logSkillResolution(event: string, data: Record<string, unknown>, level: 'debug' | 'warn' | 'error' = 'debug'): void {
  if (level === 'debug' && !skillDebugEnabled()) return;
  const payload = Object.entries(data)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  const line = `[skills:resolution] ${event}${payload ? ` ${payload}` : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Project-local skill paths. Project-owned `skills/` is the highest-priority
 * authoring source. If managed `.tower/skills/manifest.json` exists, manifest
 * entries are appended after `skills/` and host/global compatibility fallbacks
 * remain blocked.
 */
export function getProjectSkillPaths(cwd?: string): string[] {
  if (!cwd) return [];
  const managedNames = readProjectManagedManifestSkillNames(cwd);
  const nativeDir = path.join(cwd, PROJECT_NATIVE_SKILLS_DIR);
  const nativeDirs = fs.existsSync(nativeDir) ? [nativeDir] : [];
  const managedSkillDirs = managedNames ? getProjectManagedSkillDirs(cwd) : [];

  if (managedNames) {
    const paths = [...nativeDirs, ...managedSkillDirs.filter((dir) => fs.existsSync(dir))];
    const blockedCompatDirs = [
      path.join(cwd, PROJECT_PI_SKILLS_DIR),
      path.join(cwd, PROJECT_AGENTS_SKILLS_DIR),
      path.join(cwd, PROJECT_LEGACY_CLAUDE_SKILLS_DIR),
    ].filter((dir) => fs.existsSync(dir));
    if (blockedCompatDirs.length > 0) {
      logSkillResolution('project-manifest-blocked-compat-paths', {
        resolutionSource: 'project-skills+project-manifest',
        manifestPath: path.join(cwd, PROJECT_MANAGED_SKILLS_DIR, PROJECT_MANAGED_SKILLS_MANIFEST),
        blockedReason: 'project_manifest_present',
        blockedPaths: blockedCompatDirs,
      }, 'warn');
    }
    warnOnProjectSkillShadowing(paths);
    return paths;
  }

  const candidateDirs = [
    nativeDir,
    path.join(cwd, PROJECT_PI_SKILLS_DIR),
    path.join(cwd, PROJECT_AGENTS_SKILLS_DIR),
    path.join(cwd, PROJECT_LEGACY_CLAUDE_SKILLS_DIR),
  ];
  const paths = candidateDirs.filter((dir) => fs.existsSync(dir));
  warnOnProjectSkillShadowing(candidateDirs);
  return paths;
}

function getProjectManagedSkillDirs(cwd?: string): string[] {
  const names = readProjectManagedManifestSkillNames(cwd);
  if (!cwd || !names) return [];
  const managedRoot = path.join(cwd, PROJECT_MANAGED_SKILLS_DIR);
  return [...names].sort().map((name) => path.join(managedRoot, name));
}

export function hasProjectManagedSkillManifest(cwd?: string): boolean {
  if (!cwd) return false;
  return fs.existsSync(path.join(cwd, PROJECT_MANAGED_SKILLS_DIR, PROJECT_MANAGED_SKILLS_MANIFEST));
}

export async function hasProjectManagedSkillManifestForContext(projectId?: string | null, cwd?: string): Promise<boolean> {
  const projectRoot = await resolveProjectSkillRoot(cwd, projectId);
  return hasProjectManagedSkillManifest(projectRoot ?? undefined);
}

function readProjectManagedManifestSkillNames(cwd?: string): Set<string> | null {
  if (!cwd) return null;
  const manifestPath = path.join(cwd, PROJECT_MANAGED_SKILLS_DIR, PROJECT_MANAGED_SKILLS_MANIFEST);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const names = new Set<string>();
    const skills = Array.isArray(data?.skills) ? data.skills : [];
    for (const entry of skills) {
      if (typeof entry === 'string') names.add(entry);
      else if (entry && typeof entry.name === 'string') names.add(entry.name);
    }
    return names;
  } catch {
    console.warn(`[skills] failed to parse project managed skill manifest: ${manifestPath}`);
    return new Set();
  }
}

function warnOnProjectSkillShadowing(candidateDirs: string[]): void {
  try {
    const ownerByName = new Map<string, string>();
    const conflicts = new Map<string, string[]>();
    for (const dir of candidateDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const name of listSkillDirNames(dir)) {
        const first = ownerByName.get(name);
        if (first) {
          conflicts.set(name, [...(conflicts.get(name) ?? [first]), dir]);
        } else {
          ownerByName.set(name, dir);
        }
      }
    }
    if (conflicts.size > 0) {
      console.warn(
        `[skills] project skill shadowing: earlier project skill path wins for ${[...conflicts.keys()].sort().join(', ')}`,
      );
    }
  } catch {}
}

function listSkillDirNames(root: string): Set<string> {
  return new Set(listSkillLocations(root).map((loc) => loc.name));
}

function listSkillLocations(root: string): Array<{ name: string; skillDir: string }> {
  if (!fs.existsSync(root)) return [];
  if (fs.existsSync(path.join(root, 'SKILL.md'))) {
    return [{ name: path.basename(root), skillDir: root }];
  }
  const locations: Array<{ name: string; skillDir: string }> = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const skillDir = path.join(root, item.name);
    if (fs.existsSync(path.join(skillDir, 'SKILL.md'))) locations.push({ name: item.name, skillDir });
  }
  return locations;
}

async function resolveProjectRootPath(projectId?: string | null): Promise<string | null> {
  if (!projectId) return null;
  const project = await queryOne<{ root_path: string }>('SELECT root_path FROM projects WHERE id = $1', [projectId]);
  return project?.root_path ?? null;
}

async function resolveProjectSkillRoot(cwd?: string, projectId?: string | null): Promise<string | null> {
  return resolveSessionProjectRoot(cwd) ?? await resolveProjectRootPath(projectId) ?? cwd ?? null;
}

function getProjectFilesystemSkillById(id: string): (SkillMeta & { content: string }) | null {
  const skillPath = projectFilesystemSkillPathFromId(id);
  if (!skillPath || !fs.existsSync(skillPath)) return null;
  const skillDir = path.dirname(skillPath);
  const name = path.basename(skillDir);
  const content = fs.readFileSync(skillPath, 'utf-8');
  return projectFilesystemSkillToMeta(name, skillPath, content);
}

function projectFilesystemSkillPathFromId(id: string): string | null {
  if (!id.startsWith(PROJECT_FS_ID_PREFIX)) return null;
  let decoded = '';
  try {
    decoded = Buffer.from(id.slice(PROJECT_FS_ID_PREFIX.length), 'base64url').toString('utf-8');
  } catch {
    return null;
  }
  const skillPath = path.resolve(decoded);
  if (path.basename(skillPath) !== 'SKILL.md') return null;
  const projectRoot = resolveSessionProjectRoot(skillPath);
  if (!projectRoot) return null;
  const rel = path.relative(projectRoot, skillPath).split(path.sep).join('/');
  if (!/^(\.tower\/skills|skills|\.pi\/skills|\.agents\/skills|\.claude\/skills)\/[^/]+\/SKILL\.md$/.test(rel)) {
    return null;
  }
  return skillPath;
}

function updateProjectFilesystemSkill(id: string, data: {
  name?: string;
  content?: string;
  description?: string;
  category?: string;
  enabled?: boolean;
  visibility?: SkillVisibility;
}): boolean | null {
  const skillPath = projectFilesystemSkillPathFromId(id);
  if (!skillPath || !fs.existsSync(skillPath)) return null;
  const skillDir = path.dirname(skillPath);
  const projectRoot = resolveSessionProjectRoot(skillPath);
  if (!projectRoot) return null;
  const rel = path.relative(projectRoot, skillPath).split(path.sep).join('/');
  if (rel.startsWith('.tower/skills/')) {
    throw new Error('Managed .tower/skills are read-only generated runtime copies. Edit the managed source and re-materialize.');
  }
  if (data.name && data.name !== path.basename(skillDir)) {
    validateSkillFolderName(data.name);
    const parent = path.dirname(skillDir);
    const targetDir = path.join(parent, data.name);
    if (fs.existsSync(targetDir)) throw new Error(`Project skill already exists: ${data.name}`);
    fs.renameSync(skillDir, targetDir);
    const newSkillPath = path.join(targetDir, 'SKILL.md');
    if (data.content !== undefined) fs.writeFileSync(newSkillPath, data.content, 'utf-8');
    return true;
  }
  if (data.content !== undefined) fs.writeFileSync(skillPath, data.content, 'utf-8');
  return true;
}

function deleteProjectFilesystemSkill(id: string): boolean | null {
  const skillPath = projectFilesystemSkillPathFromId(id);
  if (!skillPath || !fs.existsSync(skillPath)) return null;
  const skillDir = path.dirname(skillPath);
  const projectRoot = resolveSessionProjectRoot(skillPath);
  if (!projectRoot) return null;
  const rel = path.relative(projectRoot, skillPath).split(path.sep).join('/');
  if (rel.startsWith('.tower/skills/')) {
    throw new Error('Managed .tower/skills are read-only generated runtime copies. Update managed source/materialization instead.');
  }
  fs.rmSync(skillDir, { recursive: true, force: true });
  return true;
}

function loadProjectFilesystemSkills(cwd?: string): Array<SkillMeta & { content: string }> {
  const result: Array<SkillMeta & { content: string }> = [];
  const seen = new Set<string>();

  for (const root of getProjectSkillPaths(cwd)) {
    for (const loc of listSkillLocations(root)) {
      const { name, skillDir } = loc;
      if (seen.has(name)) continue;
      seen.add(name);
      // DB-managed project materialization is loaded from skill_registry, not
      // as a filesystem-authored project skill. If its DB row was deleted, this
      // marker also keeps the leftover folder inert instead of re-enabling it.
      if (fs.existsSync(path.join(skillDir, DB_MANAGED_SKILL_MARKER))) continue;
      const skillPath = path.join(skillDir, 'SKILL.md');
      let content = '';
      try {
        content = fs.readFileSync(skillPath, 'utf-8');
      } catch {
        continue;
      }
      result.push(projectFilesystemSkillToMeta(name, skillPath, content));
    }
  }

  return result;
}

function validateSkillFolderName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || name.endsWith('-') || name.includes('--')) {
    throw new Error('Invalid skill name: use lowercase letters, numbers, and single hyphens');
  }
}

function projectFilesystemSkillToMeta(name: string, skillPath: string, content: string): SkillMeta & { content: string } {
  const stat = fs.statSync(skillPath);
  const description = parseFrontmatterField(content, 'description') || `Project skill: ${name}`;
  return {
    id: `${PROJECT_FS_ID_PREFIX}${Buffer.from(path.resolve(skillPath)).toString('base64url')}`,
    name,
    scope: 'project',
    description,
    category: 'general',
    enabled: true,
    source: 'project-fs',
    skillPath,
    projectId: null,
    userId: null,
    tier: 'team',
    owner: null,
    ownership: 'project',
    visibility: 'default',
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    content,
  } as SkillMeta & { content: string };
}

/**
 * Company skills directory adapter.
 *
 * Compatibility shim: callers that still expect a single company skill root get
 * the preferred library directory. Multi-root callers should use
 * `getLibrarySkillDirs()` directly.
 */
export function getCompanySkillsDir(): string {
  return getLibrarySkillsDir();
}

/**
 * Runtime skill path adapter.
 *
 * Pi-first sessions consume generated runtime output where available:
 *   system source → data/runtime-skills/pi/system
 *
 * During migration, Pi still includes legacy `.claude` company paths after the
 * generated path so not-yet-captured system skills remain available on customer
 * VMs. If a project has `.tower/skills/manifest.json`, the effective project
 * set is `projects/<project>/skills` first, then manifest-listed `.tower/skills`.
 * Pi/Agent/legacy project dot-folders and host-global company fallbacks are
 * blocked in that manifest-backed mode.
 */
export async function getMaterializedSkillPaths(opts: MaterializedSkillPathOptions): Promise<string[]> {
  const paths: string[] = [];

  void opts.projectId;
  void opts.username;

  const projectRoot = await resolveProjectSkillRoot(opts.cwd, opts.projectId);
  const projectSkillPaths = getProjectSkillPaths(projectRoot ?? undefined);
  const projectManagedSkillsReady = hasProjectManagedSkillManifest(projectRoot ?? undefined);

  if (opts.runtime === 'pi') {
    if (!projectManagedSkillsReady) {
      const piSystemPath = materializeSystemSkillsForPi();
      if (piSystemPath) paths.push(piSystemPath);
      // Non-project/operator fallback only. Normal project sessions with
      // `.tower/skills/manifest.json` must not see global `~/.claude/skills`.
      paths.push(getCompanySkillsDir());
    } else {
      logSkillResolution('runtime-path-blocked', {
        runtime: opts.runtime,
        resolutionSource: 'project-manifest',
        blockedReason: 'project_manifest_present',
        blockedPath: getCompanySkillsDir(),
      }, 'warn');
    }
  } else {
    if (!projectManagedSkillsReady) {
      paths.push(getCompanySkillsDir());
    } else {
      logSkillResolution('runtime-path-blocked', {
        runtime: opts.runtime,
        resolutionSource: 'project-manifest',
        blockedReason: 'project_manifest_present',
        blockedPath: getCompanySkillsDir(),
      }, 'warn');
    }
  }

  paths.push(...projectSkillPaths);

  const unique = Array.from(new Set(paths.filter(Boolean)));
  logSkillResolution('runtime-paths', {
    runtime: opts.runtime,
    resolutionSource: projectManagedSkillsReady ? 'project-skills+project-manifest' : 'compatibility-merged',
    paths: unique,
  });
  return unique;
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function loadTeamskillsCatalogMetas(username?: string | null): SkillMeta[] {
  const names = readTeamskillsSkillset([]);
  return names
    .map((name) => resolveRegistrySkillBundle(name))
    .filter((bundle): bundle is RegistrySkillBundle => !!bundle)
    .map((bundle) => teamskillsBundleToMeta(bundle))
    .filter((meta) => meta.visibility !== 'hidden' && isAccessAllowed(meta.access as LibrarySkill['access'], username));
}

function getTeamskillsSkillByName(name: string): (SkillMeta & { content: string }) | null {
  const bundle = resolveRegistrySkillBundle(name);
  if (!bundle) return null;
  const content = fs.readFileSync(bundle.skillPath, 'utf-8');
  return { ...teamskillsBundleToMeta(bundle, content), content } as SkillMeta & { content: string };
}

function teamskillsBundleToMeta(bundle: RegistrySkillBundle, content?: string): SkillMeta {
  const stat = fs.statSync(bundle.skillPath);
  const body = content ?? fs.readFileSync(bundle.skillPath, 'utf-8');
  return {
    id: bundle.name,
    name: bundle.name,
    scope: 'company',
    description: parseFrontmatterField(body, 'description') || `Organization skill: ${bundle.name}`,
    category: 'general',
    enabled: true,
    source: 'library',
    skillPath: bundle.skillPath,
    projectId: null,
    userId: null,
    tier: 'team',
    owner: 'teamskills',
    catalog: 'local',
    ownership: 'vm-local',
    visibility: bundle.visibility,
    canonicalId: bundle.canonicalId,
    bundleDigest: bundle.bundleDigest,
    ...(bundle.sourceCommit ? { sourceCommit: bundle.sourceCommit } : {}),
    origin: bundle.origin,
    runtimeRequirements: bundle.runtimeRequirements,
    portability: bundle.portability,
    access: bundle.access,
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
  } as SkillMeta;
}

function librarySkillToMeta(s: LibrarySkill): SkillMeta {
  return {
    id: s.name, // synthetic: library skills use name as stable id
    name: s.name,
    scope: 'company',
    description: s.description,
    category: inferCategoryFromTags(s.tags),
    // `enabled` here means prompt-default, not list visibility.
    enabled: s.visibility === 'default',
    source: 'library',
    skillPath: s.skillPath,
    projectId: null,
    userId: null,
    tier: s.tier,
    owner: s.owner,
    catalog: s.catalog,
    ownership: s.catalog === 'local' ? 'vm-local' : 'system',
    visibility: s.visibility,
    runtimeRequirements: s.runtimeRequirements,
    portability: s.portability,
    distribution: s.distribution,
    access: s.access,
    createdAt: '',
    updatedAt: '',
  } as SkillMeta;
}

function isLibrarySkillListVisible(s: LibrarySkill, username?: string | null): boolean {
  if (s.visibility === 'hidden') return false;
  return isAccessAllowed(s.access, username);
}

function isLibrarySkillPromptActive(s: LibrarySkill, userPrefs: Map<string, boolean>, username?: string | null): boolean {
  if (!isLibrarySkillListVisible(s, username)) return false;

  const pref = userPrefs.get(s.name);
  if (s.visibility === 'public' || s.visibility === 'private') {
    return pref === true;
  }
  return pref !== false;
}

function isAccessAllowed(access: LibrarySkill['access'], username?: string | null): boolean {
  // Backward compatibility: no access block means everyone.
  if (!access || access.length === 0) return true;
  if (access.includes('everyone')) return true;
  if (username && access.includes(`user:${username}`)) return true;
  // group:<name> is reserved for a future group-membership-aware filter.
  return false;
}

function rowToMeta(row: any): SkillMeta {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    description: row.description || '',
    category: row.category || 'general',
    enabled: !!row.enabled,
    source: row.source || 'custom',
    skillPath: row.skill_path || null,
    projectId: row.project_id || null,
    userId: row.user_id || null,
    // Phase A visibility — populated by listSkills JOIN; getSkill (single row) leaves them undefined.
    createdByName: row.created_by_name ?? null,
    projectName: row.project_name ?? null,
    // Project skills are always 'team' tier (admin/tower-admin reserved for library)
    tier: 'team',
    // Phase B option B — owner is library-only metadata; user-authored skills have null owner.
    // Future: derive from creating user's organization.
    owner: null,
    ownership: 'project',
    visibility: row.visibility || 'default',
    runtimeRequirements: row.runtime_requirements && Object.keys(row.runtime_requirements).length > 0 ? row.runtime_requirements : undefined,
    portability: row.portability && Object.keys(row.portability).length > 0 ? row.portability : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function inferCategoryFromTags(tags: string[]): string {
  if (!tags || tags.length === 0) return 'general';
  // First tag wins (core, business, docs, presentation, browser, dev, meta, tower-ops, internal)
  return tags[0];
}

/** Extract a frontmatter field from SKILL.md content */
export function parseFrontmatterField(content: string, field: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return '';
  const fm = fmMatch[1];

  // Block scalar (| or >)
  const block = fm.match(new RegExp(`^${field}:\\s*[|>][^\n]*\n((?:[ \\t]+[^\n]*\n?)+)`, 'm'));
  if (block) {
    return block[1].replace(/^[ \t]+/gm, '').trim().split('\n')[0];
  }

  // Single line
  const single = fm.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  if (single) {
    const val = single[1].trim();
    if (val.startsWith('"') && val.endsWith('"')) return val.slice(1, -1);
    return val;
  }

  return '';
}
