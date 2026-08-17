#!/usr/bin/env npx tsx
/**
 * scan-orphan-projects.ts — workspace/projects/ ↔ DB projects 대조 + 리포트 생성.
 *
 * 배경: workspace/decisions/2026-04-18-session-scoped-write-guard.md 의 P2 follow-up.
 *   "admin 우회 + workspace/projects 공개 루트" 조합으로 DB 에 등록되지 않은
 *   고아 폴더가 생성될 수 있다 (실제 사례: tower-brain/). Session Write Guard 로
 *   신규 고아 발생은 막았지만, 이미 남아있거나 외부 경로로 들어온 고아를
 *   주기적으로 탐지해야 한다.
 *
 * 동작:
 *   1. workspace/projects/ 의 최상위 디렉토리 목록 수집 (파일은 무시)
 *   2. DB projects.root_path 전체 조회 (archived 포함 — archived 도 등록된 것)
 *   3. root_path 의 longest-prefix-match 로 각 폴더를 매핑
 *      - 폴더 경로 자체 또는 상위 프로젝트 root_path 에 포함되면 "등록됨"
 *      - 어떤 프로젝트에도 매핑되지 않으면 "고아"
 *   4. workspace/published/orphaned-projects.md 에 리포트 생성
 *      - 고아 목록 + 최근 수정 시각 + 크기 + 추천 조치
 *      - 통계: total / registered / orphan / archived
 *   5. (사이드카) workspace/published/orphaned-projects.json — Hub UI 가 읽기 쉬운 JSON
 *
 * 쓰기만:
 *   - 리포트 파일 2개. DB / 다른 경로는 절대 건드리지 않는다 (read-only scan + report-only).
 *
 * 실행:
 *   cd ~/tower && npx tsx scripts/scan-orphan-projects.ts
 *   cd ~/tower && npx tsx scripts/scan-orphan-projects.ts --json-only
 *   cd ~/tower && npx tsx scripts/scan-orphan-projects.ts --dry-run   (파일 안 씀, stdout 만)
 *
 * Cron (주 1회, 월 4:30 KST):
 *   30 4 * * 1 cd ~/tower && /usr/bin/env npx tsx scripts/scan-orphan-projects.ts >> ~/tower-backups/orphan-scan.log 2>&1
 */

import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ── .env 로드 (backup.sh / migrate-sqlite-to-pg.ts 와 동일 패턴) ──
function loadEnv(): void {
  try {
    const envPath = path.join(PROJECT_ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (err) {
    console.warn('[scan-orphan-projects] .env load failed (continuing):', (err as Error).message);
  }
}

// ── CLI ──

interface CliOpts {
  dryRun: boolean;
  jsonOnly: boolean;
  mdOnly: boolean;
  workspaceRoot: string;
  publishedDir: string;
}

function parseArgs(): CliOpts {
  const argv = process.argv.slice(2);
  const opts: CliOpts = {
    dryRun: false,
    jsonOnly: false,
    mdOnly: false,
    workspaceRoot: process.env.WORKSPACE_ROOT || path.join(os.homedir(), 'workspace'),
    publishedDir: '', // filled below
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json-only') opts.jsonOnly = true;
    else if (a === '--md-only') opts.mdOnly = true;
    else if (a === '--workspace-root') opts.workspaceRoot = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: npx tsx scripts/scan-orphan-projects.ts [options]

Options:
  --dry-run           Don't write report files, only print summary to stdout.
  --json-only         Skip markdown report, only write JSON sidecar.
  --md-only           Skip JSON sidecar, only write markdown report.
  --workspace-root P  Override WORKSPACE_ROOT (default: \$WORKSPACE_ROOT or ~/workspace).
  -h, --help          This help.`);
      process.exit(0);
    }
  }
  opts.publishedDir = path.join(opts.workspaceRoot, 'published');
  return opts;
}

// ── 고아 판정 ──

interface DbProject {
  id: string;
  name: string;
  root_path: string | null;
  archived: number | null;
  user_id: number | null;
  created_at: string;
}

interface FolderInfo {
  name: string;
  path: string;
  sizeBytes: number;
  fileCount: number;
  mtime: Date;
}

interface Match {
  folder: FolderInfo;
  status: 'registered' | 'archived' | 'orphan';
  matchedProjectId?: string;
  matchedProjectName?: string;
  matchedRootPath?: string;
}

/** workspace/projects/ 바로 아래의 디렉토리만 수집 (심볼릭/파일은 제외). */
function scanProjectFolders(projectsDir: string): FolderInfo[] {
  if (!fs.existsSync(projectsDir)) return [];
  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  const results: FolderInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // skip files, symlinks-to-file
    const full = path.join(projectsDir, entry.name);
    try {
      const stat = fs.statSync(full);
      const { size, count } = folderSize(full);
      results.push({
        name: entry.name,
        path: full,
        sizeBytes: size,
        fileCount: count,
        mtime: stat.mtime,
      });
    } catch (err) {
      console.warn(`[scan-orphan-projects] stat failed for ${full}: ${(err as Error).message}`);
    }
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

/** 재귀 없이, du 쓰지 않고 싸게 측정 (최대 깊이 4 + 최대 5000파일). 고아는 보통 얕다. */
function folderSize(dir: string): { size: number; count: number } {
  let size = 0;
  let count = 0;
  const MAX_FILES = 5000;
  const MAX_DEPTH = 4;
  const stack: { p: string; d: number }[] = [{ p: dir, d: 0 }];
  while (stack.length > 0 && count < MAX_FILES) {
    const { p, d } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) {
        if (d < MAX_DEPTH) stack.push({ p: full, d: d + 1 });
      } else if (e.isFile()) {
        try {
          size += fs.statSync(full).size;
          count++;
          if (count >= MAX_FILES) break;
        } catch {
          // skip
        }
      }
    }
  }
  return { size, count };
}

/** folder 가 어느 project.root_path 에 귀속되는지 longest-prefix-match. */
function resolveMatch(folder: FolderInfo, projects: DbProject[]): Match {
  const folderResolved = path.resolve(folder.path);
  let best: DbProject | null = null;
  let bestLen = 0;
  for (const p of projects) {
    if (!p.root_path) continue;
    const rp = path.resolve(p.root_path.replace(/\/$/, ''));
    // folder 자체 또는 folder 가 rp 하위 → 등록된 것으로 간주.
    // 반대로 rp 가 folder 하위인 경우는 "폴더 내 서브프로젝트" — 본 폴더는 여전히 orphan
    // 일 수 있으므로 여기서는 매칭하지 않는다. (상위-포함 관계만 인정)
    if (folderResolved === rp || folderResolved.startsWith(rp + path.sep)) {
      if (rp.length > bestLen) {
        best = p;
        bestLen = rp.length;
      }
    }
  }
  if (best) {
    return {
      folder,
      status: best.archived ? 'archived' : 'registered',
      matchedProjectId: best.id,
      matchedProjectName: best.name,
      matchedRootPath: best.root_path ?? undefined,
    };
  }
  return { folder, status: 'orphan' };
}

// ── 리포트 ──

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDate(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

interface ReportPayload {
  generatedAt: string;
  workspaceRoot: string;
  stats: {
    total: number;
    registered: number;
    archived: number;
    orphan: number;
    dbProjectsTotal: number;
    dbProjectsWithRootPath: number;
  };
  orphans: Array<{
    name: string;
    path: string;
    sizeBytes: number;
    fileCount: number;
    mtime: string;
  }>;
  archivedFolders: Array<{
    name: string;
    projectId: string;
    projectName: string;
  }>;
}

function buildMarkdown(report: ReportPayload): string {
  const lines: string[] = [];
  lines.push('# 고아 프로젝트 폴더 스캔 리포트');
  lines.push('');
  lines.push(`> 자동 생성. 다음 스캔이 이 파일을 덮어씁니다. 수동 메모는 이 파일에 남기지 마세요.`);
  lines.push('');
  lines.push(`- **Generated:** ${report.generatedAt}`);
  lines.push(`- **Workspace root:** \`${report.workspaceRoot}\``);
  lines.push(`- **Source decision:** \`workspace/decisions/2026-04-18-session-scoped-write-guard.md\` (P2 follow-up)`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|---|---:|`);
  lines.push(`| Folders in workspace/projects/ | ${report.stats.total} |`);
  lines.push(`| ✅ Registered (active) | ${report.stats.registered} |`);
  lines.push(`| 📦 Registered (archived) | ${report.stats.archived} |`);
  lines.push(`| ⚠️ Orphan (not in DB) | ${report.stats.orphan} |`);
  lines.push(`| DB projects total | ${report.stats.dbProjectsTotal} |`);
  lines.push(`| DB projects with root_path | ${report.stats.dbProjectsWithRootPath} |`);
  lines.push('');

  if (report.orphans.length === 0) {
    lines.push('## ⚠️ Orphans');
    lines.push('');
    lines.push('No orphan folders detected. 🎉');
    lines.push('');
  } else {
    lines.push('## ⚠️ Orphans');
    lines.push('');
    lines.push('다음 폴더는 `workspace/projects/` 에 존재하지만 `projects` 테이블의 어떤 `root_path` 에도 매핑되지 않았습니다.');
    lines.push('');
    lines.push(`| Folder | Size | Files | Last modified |`);
    lines.push(`|---|---:|---:|---|`);
    for (const o of report.orphans) {
      lines.push(`| \`${o.name}\` | ${fmtBytes(o.sizeBytes)} | ${o.fileCount} | ${o.mtime} |`);
    }
    lines.push('');
    lines.push('### 권장 조치');
    lines.push('');
    lines.push('각 고아 폴더에 대해 아래 중 하나를 선택하세요:');
    lines.push('');
    lines.push('1. **귀속(Adopt)** — 내용을 살펴보고 기존 프로젝트로 옮기거나, 새 프로젝트로 DB 등록합니다.');
    lines.push('   - 관리자 UI → Projects → "Register existing folder" (TBD) 또는');
    lines.push('   - 직접 DB INSERT: `INSERT INTO projects (id, name, root_path, user_id, sort_order) VALUES (...)`.');
    lines.push('2. **삭제(Delete)** — 테스트/실수로 생성된 빈 폴더는 제거합니다. 삭제 전에 내용 확인 필수.');
    lines.push('3. **무시(Ignore)** — `.`/`_` 로 시작하는 시스템 폴더는 다음 릴리스에서 스캔 예외에 추가합니다.');
    lines.push('');
    lines.push('> **주의:** Session Write Guard(2026-04-18) 이후 신규 고아 생성은 차단됩니다. 여기 나열된 것은');
    lines.push('> 과거 생성물 또는 외부(rsync/수동 mkdir) 경로로 들어온 것입니다.');
    lines.push('');
  }

  if (report.archivedFolders.length > 0) {
    lines.push('## 📦 Archived (참고)');
    lines.push('');
    lines.push('DB 상 `archived=1` 로 표시된 프로젝트의 폴더입니다. 삭제 후보지만 자동 삭제하지 않습니다.');
    lines.push('');
    lines.push(`| Folder | Project name | Project id |`);
    lines.push(`|---|---|---|`);
    for (const a of report.archivedFolders) {
      lines.push(`| \`${a.name}\` | ${a.projectName} | \`${a.projectId}\` |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('_본 리포트는 `scripts/scan-orphan-projects.ts` 가 주 1회 (월 04:30 KST) 생성합니다. 수동 실행: `cd ~/tower && npx tsx scripts/scan-orphan-projects.ts`._');
  lines.push('');
  return lines.join('\n');
}

// ── 메인 ──

async function main(): Promise<void> {
  loadEnv();
  const opts = parseArgs();

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error('[scan-orphan-projects] DATABASE_URL not set. Aborting.');
    process.exit(1);
  }

  const projectsDir = path.join(opts.workspaceRoot, 'projects');
  if (!fs.existsSync(projectsDir)) {
    console.error(`[scan-orphan-projects] ${projectsDir} does not exist. Aborting.`);
    process.exit(1);
  }

  // 1) 파일시스템
  const folders = scanProjectFolders(projectsDir);

  // 2) DB
  const pool = new Pool({ connectionString: DATABASE_URL });
  let projects: DbProject[];
  try {
    const { rows } = await pool.query<DbProject>(
      `SELECT id, name, root_path, archived, user_id, created_at FROM projects`
    );
    projects = rows;
  } finally {
    await pool.end();
  }

  const projectsWithRootPath = projects.filter(p => p.root_path);

  // 3) 매칭
  const matches: Match[] = folders.map(f => resolveMatch(f, projects));

  const orphans = matches.filter(m => m.status === 'orphan');
  const archived = matches.filter(m => m.status === 'archived');
  const registered = matches.filter(m => m.status === 'registered');

  // 4) 리포트 페이로드
  const report: ReportPayload = {
    generatedAt: new Date().toISOString(),
    workspaceRoot: opts.workspaceRoot,
    stats: {
      total: folders.length,
      registered: registered.length,
      archived: archived.length,
      orphan: orphans.length,
      dbProjectsTotal: projects.length,
      dbProjectsWithRootPath: projectsWithRootPath.length,
    },
    orphans: orphans.map(m => ({
      name: m.folder.name,
      path: m.folder.path,
      sizeBytes: m.folder.sizeBytes,
      fileCount: m.folder.fileCount,
      mtime: fmtDate(m.folder.mtime),
    })),
    archivedFolders: archived.map(m => ({
      name: m.folder.name,
      projectId: m.matchedProjectId ?? '',
      projectName: m.matchedProjectName ?? '',
    })),
  };

  // 5) stdout 요약 (cron 로그에 남음)
  console.log(`[scan-orphan-projects] ${report.generatedAt}`);
  console.log(`  workspace: ${opts.workspaceRoot}`);
  console.log(`  folders=${report.stats.total} registered=${report.stats.registered} archived=${report.stats.archived} orphan=${report.stats.orphan}`);
  if (orphans.length > 0) {
    console.log('  ORPHANS:');
    for (const o of report.orphans) {
      console.log(`    - ${o.name}  (${fmtBytes(o.sizeBytes)}, ${o.fileCount} files, mtime ${o.mtime})`);
    }
  }

  if (opts.dryRun) {
    console.log('[scan-orphan-projects] --dry-run: not writing report files.');
    return;
  }

  // 6) 리포트 파일 쓰기
  if (!fs.existsSync(opts.publishedDir)) {
    fs.mkdirSync(opts.publishedDir, { recursive: true });
  }

  if (!opts.jsonOnly) {
    const mdPath = path.join(opts.publishedDir, 'orphaned-projects.md');
    fs.writeFileSync(mdPath, buildMarkdown(report), 'utf-8');
    console.log(`[scan-orphan-projects] wrote ${mdPath}`);
  }

  if (!opts.mdOnly) {
    const jsonPath = path.join(opts.publishedDir, 'orphaned-projects.json');
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`[scan-orphan-projects] wrote ${jsonPath}`);
  }

  // orphan 이 있으면 exit 1 — cron 에서 알림을 붙이고 싶을 때 훅 포인트.
  // 현재 cron 설정에서는 로그만 쌓이고 인간은 리포트를 읽으면 되므로 exit 0 유지.
  // 필요 시 아래 주석 해제:
  //   if (orphans.length > 0) process.exit(2);
}

main().catch(err => {
  console.error('[scan-orphan-projects] fatal:', err);
  process.exit(1);
});
