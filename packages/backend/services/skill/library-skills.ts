/**
 * Library Skills — Tower-owned managed skill catalog/source loader.
 *
 * Preferred source:
 *  - ~/tower/config/skills/managed-skills.yaml
 *  - ~/tower/skills/managed/<name>/SKILL.md
 *
 * Legacy fallback (compatibility output only):
 *  - ~/.claude/skills/library/library.yaml
 *  - ~/.claude/skills/<name>/SKILL.md
 *
 * 2026-04-17 결정 (workspace/decisions/2026-04-17-skill-db-simplification.md):
 *  - company 스킬은 DB에서 제거하고 catalog + 디스크 source로 사용한다.
 *  - DB는 personal/project 스킬과 user_skill_prefs, skill_providers만 담당한다.
 *  - seed/sync 양방향 동기화를 제거해 §21 같은 drift 사고를 구조적으로 차단한다.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse } from 'yaml';
import { parseFrontmatterField } from './skill-registry.js';
import type {
  SkillAccessGrant,
  SkillDistribution,
  SkillOwner,
  SkillPortability,
  SkillRuntimeRequirements,
  SkillTier,
  SkillVisibility,
} from '@tower/shared';

// ── Paths ─────────────────────────────────────────────────────────────
const TOWER_ROOT = process.env.TOWER_ROOT || path.join(os.homedir(), 'tower');
const TOWER_MANAGED_SKILLS_DIR =
  process.env.TOWER_MANAGED_SKILLS_DIR || path.join(TOWER_ROOT, 'skills', 'managed');
const TOWER_LIBRARY_YAML =
  process.env.TOWER_MANAGED_SKILLS_CATALOG || path.join(TOWER_ROOT, 'config', 'skills', 'managed-skills.yaml');
const TOWER_LOCAL_LIBRARY_YAML =
  process.env.TOWER_LOCAL_SKILLS_CATALOG || path.join(TOWER_ROOT, 'config', 'skills', 'local-managed-skills.yaml');

const LEGACY_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const LEGACY_LIBRARY_YAML = path.join(LEGACY_SKILLS_DIR, 'library', 'library.yaml');
const LEGACY_LOCAL_LIBRARY_YAML = path.join(LEGACY_SKILLS_DIR, 'library', 'local-library.yaml');

// ── Types ─────────────────────────────────────────────────────────────
export interface LibrarySkill {
  /** Unique skill name — matches the registered library skill name. */
  name: string;
  /** Short human-readable description (from SKILL.md frontmatter). */
  description: string;
  /** Full SKILL.md content (used by getSkillByName for Pi engine prepend, etc.). */
  content: string;
  /** Tags declared in catalog YAML (used for profile filtering). */
  tags: string[];
  /** Version declared in catalog YAML (optional). */
  version: string;
  /** Absolute path to the bundle root directory that owns this skill. */
  sourceRoot: string;
  /** Absolute path to the resolved SKILL.md file on disk. */
  skillPath: string;
  /** Audience tier (Phase B). Defaults to 'team' if absent. */
  tier: SkillTier;
  /** Owner organization (Phase B option B). Defaults to null if absent. */
  owner: SkillOwner | null;
  /** Which catalog declared this entry: operator-managed system vs VM-local tenant catalog. */
  catalog: 'system' | 'local';
  /** Registry visibility. Hidden/public affect prompt injection separately from list visibility. */
  visibility: SkillVisibility;
  /** Abstract runtime capability hints — never concrete Tower tool names. */
  runtimeRequirements?: SkillRuntimeRequirements;
  /** Portability level and warnings. */
  portability?: SkillPortability;
  /** Distribution/install policy. */
  distribution?: SkillDistribution;
  /** Minimal exposure ACL. Missing means everyone. */
  access?: SkillAccessGrant[];
}

interface LibraryYamlEntry {
  name: string;
  tags: string[];
  version: string;
  sourceRoot: string;
  skillPath: string;
  tier: SkillTier;
  owner: SkillOwner | null;
  /** Which catalog declared this entry: operator-managed system vs VM-local tenant catalog. */
  catalog: 'system' | 'local';
  visibility: SkillVisibility;
  runtimeRequirements?: SkillRuntimeRequirements;
  portability?: SkillPortability;
  distribution?: SkillDistribution;
  access?: SkillAccessGrant[];
}

interface CatalogSpec {
  yamlPath: string;
  defaultSkillsDir: string;
  catalog: 'system' | 'local';
}

// ── Cache ─────────────────────────────────────────────────────────────
interface Cache {
  catalogFingerprint: string;
  entries: LibraryYamlEntry[];
  /** name → SKILL.md mtime, for invalidating individual skills. */
  skillMtimes: Map<string, number>;
  /** name → fully-hydrated LibrarySkill. */
  skills: Map<string, LibrarySkill>;
}

let cache: Cache | null = null;

// ── YAML parsing ─────────────────────────────────────────────────────
/** Parse `library.yaml` and extract `library.skills` entries. */
function parseLibraryYaml(yamlContent: string, spec: CatalogSpec): LibraryYamlEntry[] {
  let parsed: unknown;
  try {
    parsed = parse(yamlContent);
  } catch {
    return [];
  }

  const library = asRecord(parsed)?.library;
  const skills = asRecord(library)?.skills;
  if (!Array.isArray(skills)) return [];

  const entries: LibraryYamlEntry[] = [];
  for (const item of skills) {
    const entry = parseLibraryYamlEntry(item, spec);
    if (entry) entries.push(entry);
  }

  return entries;
}

function parseLibraryYamlEntry(raw: unknown, spec: CatalogSpec): LibraryYamlEntry | null {
  const record = asRecord(raw);
  const name = readString(record?.name);
  if (!name) return null;

  const source = readScalarString(record?.source);
  const { sourceRoot, skillPath } = resolveSkillSource(name, source, spec.defaultSkillsDir);

  return {
    name,
    tags: readStringArray(record?.tags) ?? [],
    version: readScalarString(record?.version) ?? '',
    sourceRoot,
    skillPath,
    tier: parseTier(record?.tier),
    owner: parseOwner(record?.owner),
    catalog: spec.catalog,
    visibility: parseVisibility(record),
    runtimeRequirements: parseRuntimeRequirements(record),
    portability: parsePortability(record),
    distribution: parseDistribution(record),
    access: parseAccess(record),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readScalarString(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string');
  return strings.length > 0 ? strings : [];
}

function parseTier(value: unknown): SkillTier {
  const raw = readString(value);
  if (raw === 'tower-admin' || raw === 'workspace-admin' || raw === 'team') return raw;
  return 'team';
}

function parseOwner(value: unknown): SkillOwner | null {
  return readScalarString(value) ?? null;
}

function expandTilde(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function resolveSkillSource(name: string, source: string | undefined, defaultSkillsDir: string): { sourceRoot: string; skillPath: string } {
  const resolvedSource = source
    ? resolveConfiguredPath(source)
    : path.resolve(defaultSkillsDir, name, 'SKILL.md');
  return normalizeSkillSource(resolvedSource);
}

function resolveConfiguredPath(configuredPath: string): string {
  const expanded = expandTilde(configuredPath.trim());
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(TOWER_ROOT, expanded);
}

function normalizeSkillSource(resolvedPath: string): { sourceRoot: string; skillPath: string } {
  const normalized = path.normalize(resolvedPath);
  const stat = safeStat(normalized);

  if (stat?.isDirectory()) {
    return {
      sourceRoot: normalized,
      skillPath: path.join(normalized, 'SKILL.md'),
    };
  }

  if (stat?.isFile() || path.basename(normalized) === 'SKILL.md') {
    return {
      sourceRoot: path.dirname(normalized),
      skillPath: normalized,
    };
  }

  return {
    sourceRoot: normalized,
    skillPath: path.join(normalized, 'SKILL.md'),
  };
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function parseVisibility(record: Record<string, unknown> | null): SkillVisibility {
  const raw = readScalarString(record?.visibility);
  if (raw === 'private' || raw === 'public' || raw === 'default' || raw === 'hidden') return raw;
  if (raw === 'operator') return 'hidden';
  return 'default';
}

function parseRuntimeRequirements(record: Record<string, unknown> | null): SkillRuntimeRequirements | undefined {
  const runtime = asRecord(record?.runtime_requirements);
  const req: SkillRuntimeRequirements = {};

  const execution = readScalarString(runtime?.execution);
  const persistence = readScalarString(runtime?.persistence);
  const network = readScalarString(runtime?.network);
  const secrets = readStringArray(runtime?.secrets);
  const packages = readStringArray(runtime?.packages);

  if (execution === 'none' || execution === 'optional' || execution === 'required') req.execution = execution;
  if (persistence === 'none' || persistence === 'long_running_optional' || persistence === 'long_running_required') req.persistence = persistence;
  if (network === 'none' || network === 'optional' || network === 'required') req.network = network;
  if (secrets) req.secrets = secrets;
  if (packages) req.packages = packages;

  return Object.keys(req).length > 0 ? req : undefined;
}

function parseAccess(record: Record<string, unknown> | null): SkillAccessGrant[] | undefined {
  const values = readStringArray(record?.access);
  if (!values) return undefined;
  const grants = values.filter((value): value is SkillAccessGrant => {
    if (value === 'everyone') return true;
    if (/^user:[A-Za-z0-9._-]{2,40}$/.test(value)) return true;
    if (/^group:[A-Za-z0-9._-]{1,80}$/.test(value)) return true;
    return false;
  });
  return grants.length > 0 ? grants : undefined;
}

function parseDistribution(record: Record<string, unknown> | null): SkillDistribution | undefined {
  const distributionRecord = asRecord(record?.distribution);
  const distribution: SkillDistribution = {};

  const audience = readScalarString(distributionRecord?.audience);
  const profiles = readStringArray(distributionRecord?.profiles);
  const customerSafe = distributionRecord?.customer_safe;

  if (audience === 'moat-internal' || audience === 'operator' || audience === 'customer-admin' || audience === 'customer-user' || audience === 'public') {
    distribution.audience = audience;
  }
  if (profiles) distribution.profiles = profiles;
  if (customerSafe === true || customerSafe === 'true') distribution.customerSafe = true;
  if (customerSafe === false || customerSafe === 'false') distribution.customerSafe = false;

  return Object.keys(distribution).length > 0 ? distribution : undefined;
}

function parsePortability(record: Record<string, unknown> | null): SkillPortability | undefined {
  const portabilityRecord = asRecord(record?.portability);
  const portability: SkillPortability = {};

  const level = readScalarString(portabilityRecord?.level);
  const warnings = readStringArray(portabilityRecord?.warnings);

  if (level === 'portable' || level === 'tower-ops-only' || level === 'environment-bound') portability.level = level;
  if (warnings) portability.warnings = warnings;

  return Object.keys(portability).length > 0 ? portability : undefined;
}

const TOWER_OPS_SKILLS = new Set(['fleet', 'library', 'selfheal', 'tower-guide-update', 'skill-registry-orchestration']);

function mergePortabilityWarnings(portability: SkillPortability | undefined, content: string, skillName: string): SkillPortability | undefined {
  const existing = portability ?? {};
  if (existing.level === 'tower-ops-only' || TOWER_OPS_SKILLS.has(skillName)) return existing;
  const warnings = new Set(existing.warnings ?? []);
  const antiPatterns: Array<[RegExp, string]> = [
    [/mcp__sandbox__run/, 'Tower-specific tool name `mcp__sandbox__run` appears in skill body'],
    [/sandbox\.tool\.start|mcp__sandbox__tool_start/, 'Tower-specific persistent sandbox tool appears in skill body'],
    [/workspace\/published\/sites|published\/<slug>|publishing symlink/i, 'Tower-specific publishing path/symlink appears in skill body'],
    [/deploy-profile\.sh/, 'Tower self-host deploy-profile.sh appears in skill body'],
    [/\.env\s*(?:내용|content|읽)/i, 'Skill appears to instruct reading .env contents'],
  ];
  for (const [pattern, warning] of antiPatterns) {
    if (pattern.test(content)) warnings.add(warning);
  }
  const result: SkillPortability = {
    ...existing,
    ...(warnings.size > 0 ? { warnings: Array.from(warnings) } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

// ── Loader ────────────────────────────────────────────────────────────
function hydrateSkill(entry: LibraryYamlEntry): LibrarySkill | null {
  if (!fs.existsSync(entry.skillPath)) return null;
  const content = fs.readFileSync(entry.skillPath, 'utf-8');
  const description = parseFrontmatterField(content, 'description') || `Skill: ${entry.name}`;
  return {
    name: entry.name,
    description,
    content,
    tags: entry.tags,
    version: entry.version,
    sourceRoot: entry.sourceRoot,
    skillPath: entry.skillPath,
    tier: entry.tier,
    owner: entry.owner,
    catalog: entry.catalog,
    visibility: entry.visibility,
    runtimeRequirements: entry.runtimeRequirements,
    portability: mergePortabilityWarnings(entry.portability, content, entry.name),
    distribution: entry.distribution,
    access: entry.access,
  };
}

function getMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function getSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function loadCatalogEntries(): { catalogFingerprint: string; entries: LibraryYamlEntry[] } {
  const specs: CatalogSpec[] = [
    { yamlPath: TOWER_LIBRARY_YAML, defaultSkillsDir: TOWER_MANAGED_SKILLS_DIR, catalog: 'system' },
    { yamlPath: LEGACY_LIBRARY_YAML, defaultSkillsDir: LEGACY_SKILLS_DIR, catalog: 'system' },
    { yamlPath: TOWER_LOCAL_LIBRARY_YAML, defaultSkillsDir: TOWER_MANAGED_SKILLS_DIR, catalog: 'local' },
    { yamlPath: LEGACY_LOCAL_LIBRARY_YAML, defaultSkillsDir: LEGACY_SKILLS_DIR, catalog: 'local' },
  ];

  const catalogFingerprint = specs
    .map((spec) => `${spec.catalog}:${spec.yamlPath}:${getMtime(spec.yamlPath)}:${getSize(spec.yamlPath)}`)
    .join('|');

  const entries: LibraryYamlEntry[] = [];
  const systemNames = new Set<string>();
  const localNames = new Set<string>();

  for (const spec of specs) {
    if (!fs.existsSync(spec.yamlPath)) continue;
    const parsedEntries = parseLibraryYaml(fs.readFileSync(spec.yamlPath, 'utf-8'), spec);

    for (const entry of parsedEntries) {
      if (spec.catalog === 'system') {
        if (systemNames.has(entry.name)) continue;
        entries.push(entry);
        systemNames.add(entry.name);
        continue;
      }

      if (systemNames.has(entry.name)) {
        console.warn(
          `[skills] ${path.basename(spec.yamlPath)} entry '${entry.name}' conflicts with system skill; skipping local entry`,
        );
        continue;
      }
      if (localNames.has(entry.name)) continue;
      entries.push(entry);
      localNames.add(entry.name);
    }
  }

  return { catalogFingerprint, entries };
}

function ensureCache(): void {
  const { catalogFingerprint, entries } = loadCatalogEntries();

  if (cache && cache.catalogFingerprint === catalogFingerprint) {
    let anyStale = false;
    for (const entry of cache.entries) {
      const mtime = getMtime(entry.skillPath);
      const cachedMtime = cache.skillMtimes.get(entry.name) ?? 0;
      if (mtime === cachedMtime) continue;

      anyStale = true;
      const hydrated = hydrateSkill(entry);
      if (hydrated) {
        cache.skills.set(entry.name, hydrated);
        cache.skillMtimes.set(entry.name, mtime);
      } else {
        cache.skills.delete(entry.name);
        cache.skillMtimes.delete(entry.name);
      }
    }
    if (!anyStale) return;
    return;
  }

  const skills = new Map<string, LibrarySkill>();
  const skillMtimes = new Map<string, number>();
  for (const entry of entries) {
    const hydrated = hydrateSkill(entry);
    if (!hydrated) continue;
    skills.set(entry.name, hydrated);
    skillMtimes.set(entry.name, getMtime(entry.skillPath));
  }

  cache = { catalogFingerprint, entries, skillMtimes, skills };
}

// ── Public API ────────────────────────────────────────────────────────
/** Returns all library (company) skills as an array. Memoized. */
export function loadLibrarySkills(): LibrarySkill[] {
  ensureCache();
  return Array.from(cache!.skills.values());
}

/** Returns a map keyed by skill name. Useful for quick lookups. */
export function loadLibrarySkillsMap(): Map<string, LibrarySkill> {
  ensureCache();
  return new Map(cache!.skills);
}

/** Returns a single skill by name, or null. */
export function getLibrarySkill(name: string): LibrarySkill | null {
  ensureCache();
  return cache!.skills.get(name) ?? null;
}

/** Library skill source roots in priority order, deduped by directory path. */
export function getLibrarySkillDirs(): string[] {
  const hasTowerCatalog = fs.existsSync(TOWER_LIBRARY_YAML) || fs.existsSync(TOWER_LOCAL_LIBRARY_YAML);
  const hasLegacyCatalog = fs.existsSync(LEGACY_LIBRARY_YAML) || fs.existsSync(LEGACY_LOCAL_LIBRARY_YAML);
  const dirs = [
    ...(hasTowerCatalog ? [TOWER_MANAGED_SKILLS_DIR] : []),
    ...(hasLegacyCatalog ? [LEGACY_SKILLS_DIR] : []),
  ];
  return Array.from(new Set(dirs));
}

/** Path of the preferred library skills directory (for Pi additionalSkillPaths). */
export function getLibrarySkillsDir(): string {
  return getLibrarySkillDirs()[0] ?? LEGACY_SKILLS_DIR;
}

/** For tests / reconcile endpoints: force a reload on next access. */
export function invalidateLibraryCache(): void {
  cache = null;
}
