import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildProjectPathEnforcement,
  buildToolGuard,
  wrapPiTools,
  resolveSessionProjectRoot,
  isPrivilegedRole,
  isAdminOrOperator,
  isDotfileDenied,
  isPathAccessible,
  isPathWritableByRole,
} from './project-access.js';

const TEST_HOME = process.env.HOME || '/tmp';
const TEST_WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(TEST_HOME, 'workspace');
const TEST_TOWER_REPO_ROOT = process.env.TOWER_REPO_ROOT || path.join(TEST_HOME, 'tower');

describe('project path boundary realpath hardening', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-project-access-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('denies project-local symlinks that resolve outside the allowed project root', () => {
    const alpha = path.join(tmp, 'projects', 'alpha');
    const beta = path.join(tmp, 'projects', 'beta');
    fs.mkdirSync(alpha, { recursive: true });
    fs.mkdirSync(beta, { recursive: true });
    fs.writeFileSync(path.join(beta, 'secret.txt'), 'nope');
    fs.symlinkSync(beta, path.join(alpha, 'beta-link'), 'dir');

    const guard = buildProjectPathEnforcement([alpha]);
    const result = guard('Read', { file_path: path.join(alpha, 'beta-link', 'secret.txt') });

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.message).toContain('outside your accessible project folders');
  });

  it('allows project-local symlinks that resolve inside the same allowed project root', () => {
    const alpha = path.join(tmp, 'projects', 'alpha');
    const internal = path.join(alpha, 'internal');
    fs.mkdirSync(internal, { recursive: true });
    fs.writeFileSync(path.join(internal, 'note.txt'), 'ok');
    fs.symlinkSync(internal, path.join(alpha, 'internal-link'), 'dir');

    const guard = buildProjectPathEnforcement([alpha]);
    const result = guard('Read', { file_path: path.join(alpha, 'internal-link', 'note.txt') });

    expect(result.allowed).toBe(true);
  });

  it('denies new write targets below a project-local symlink that resolves outside the allowed root', () => {
    const alpha = path.join(tmp, 'projects', 'alpha');
    const beta = path.join(tmp, 'projects', 'beta');
    fs.mkdirSync(alpha, { recursive: true });
    fs.mkdirSync(beta, { recursive: true });
    fs.symlinkSync(beta, path.join(alpha, 'beta-link'), 'dir');

    const guard = buildProjectPathEnforcement([alpha]);
    const result = guard('Write', { file_path: path.join(alpha, 'beta-link', 'new.txt'), content: 'x' });

    expect(result.allowed).toBe(false);
  });

  it('denies writes through project-local symlinks into read-only roots', () => {
    const alpha = path.join(tmp, 'projects', 'alpha');
    const docs = path.join(tmp, 'docs');
    fs.mkdirSync(alpha, { recursive: true });
    fs.mkdirSync(docs, { recursive: true });
    fs.symlinkSync(docs, path.join(alpha, 'docs-link'), 'dir');

    const guard = buildProjectPathEnforcement([alpha, docs], { readOnlyDirs: [docs] });
    const result = guard('Write', { file_path: path.join(alpha, 'docs-link', 'guide.md') });

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.message).toContain('read-only public folder');
  });

  it('applies dotfile deny policy to the symlink-resolved target even for admin reads', async () => {
    const alpha = path.join(tmp, 'projects', 'alpha');
    const audit = path.join(tmp, '.audit');
    fs.mkdirSync(alpha, { recursive: true });
    fs.mkdirSync(audit, { recursive: true });
    fs.writeFileSync(path.join(audit, 'log.jsonl'), '{}\n');
    fs.symlinkSync(audit, path.join(alpha, 'audit-link'), 'dir');

    await expect(isPathAccessible(path.join(alpha, 'audit-link', 'log.jsonl'), 1, 'admin')).resolves.toBe(false);
  });
});

describe('wrapPiTools security parity', () => {
  it('allows viewer to use read-only finance tools like excel_read', async () => {
    const guard = buildToolGuard({ role: 'viewer' });
    const tool = {
      name: 'excel_read',
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    };

    const wrapped = wrapPiTools([tool], guard)[0];
    const result = await wrapped.execute('t1', { path: '/tmp/demo.xlsx' });

    expect(result.content[0].text).toBe('ok');
  });

  it('allows viewer to use read-only builtins like ls and find', async () => {
    const guard = buildToolGuard({ role: 'viewer' });
    const tools = [
      { name: 'ls', execute: async () => ({ content: [{ type: 'text', text: 'ls ok' }] }) },
      { name: 'find', execute: async () => ({ content: [{ type: 'text', text: 'find ok' }] }) },
    ];

    const [lsTool, findTool] = wrapPiTools(tools, guard);
    const lsResult = await lsTool.execute('t-ls', { path: '/tmp' });
    const findResult = await findTool.execute('t-find', { path: '/tmp', pattern: '*.ts' });

    expect(lsResult.content[0].text).toBe('ls ok');
    expect(findResult.content[0].text).toBe('find ok');
  });

  it('allows viewer to use read-only multi-file finance tools like excel_diff', async () => {
    const guard = buildToolGuard({ role: 'viewer' });
    const tool = {
      name: 'excel_diff',
      execute: async () => ({ content: [{ type: 'text', text: 'diff ok' }] }),
    };

    const wrapped = wrapPiTools([tool], guard)[0];
    const result = await wrapped.execute('t-diff', { files: ['/tmp/a.xlsx', '/tmp/b.xlsx'] });

    expect(result.content[0].text).toBe('diff ok');
  });

  it('enforces project path restrictions for excel_read path arguments', async () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: ['/home/tower/workspace/projects/alpha'],
    });
    const tool = {
      name: 'excel_read',
      execute: async () => ({ content: [{ type: 'text', text: 'should not run' }] }),
    };

    const wrapped = wrapPiTools([tool], guard)[0];
    const result = await wrapped.execute('t2', { path: '/etc/passwd' });

    expect(result.content[0].text).toContain('[Access Denied]');
    expect(result.content[0].text).toContain('outside your accessible project folders');
  });

  it('maps Runtime Box /workspace paths before enforcing Pi custom-tool ACLs', async () => {
    const projectRoot = '/home/tower/workspace/projects/alpha';
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: [projectRoot],
    });
    const tool = {
      name: 'excel_write',
      execute: async () => ({ content: [{ type: 'text', text: 'write ok' }] }),
    };

    const wrapped = wrapPiTools([tool], guard, { projectRoot })[0];
    const result = await wrapped.execute('t-workspace', { path: '/workspace/reports/out.xlsx' });
    expect(result.content[0].text).toBe('write ok');
  });

  it('does not allow Runtime Box /workspace path traversal through Pi custom-tool ACLs', async () => {
    const projectRoot = '/home/tower/workspace/projects/alpha';
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: [projectRoot],
    });
    const tool = {
      name: 'excel_read',
      execute: async () => ({ content: [{ type: 'text', text: 'should not run' }] }),
    };

    const wrapped = wrapPiTools([tool], guard, { projectRoot })[0];
    const result = await wrapped.execute('t-workspace-escape', { path: '/workspace/../beta/secret.xlsx' });
    expect(result.content[0].text).toContain('[Access Denied]');
  });
});

// ─── Session-scoped write guard ───────────────────────────────────────────────
// Orthogonal axis to user accessible-paths: regardless of who the user is
// (including admin), writes within a session must stay under that session's
// project root. Regression: 2026-04-18 tower-brain orphan folder incident.
// See workspace/decisions/2026-04-18-session-scoped-write-guard.md

describe('resolveSessionProjectRoot', () => {
  const base = process.env.WORKSPACE_ROOT || `${process.env.HOME || '/tmp'}/workspace`;

  it('returns the project root for cwd inside a project folder', () => {
    expect(resolveSessionProjectRoot(`${base}/projects/demo-org`)).toBe(`${base}/projects/demo-org`);
    expect(resolveSessionProjectRoot(`${base}/projects/demo-org/strategy/notes`)).toBe(`${base}/projects/demo-org`);
  });

  it('returns null for cwd outside workspace/projects/', () => {
    expect(resolveSessionProjectRoot(`${base}/published/demo`)).toBeNull();
    expect(resolveSessionProjectRoot('/tmp/something')).toBeNull();
    expect(resolveSessionProjectRoot(undefined)).toBeNull();
  });

  it('returns null when cwd IS workspace/projects itself (no slug)', () => {
    expect(resolveSessionProjectRoot(`${base}/projects`)).toBeNull();
  });
});

describe('buildToolGuard — user-accessible cross-project file writes', () => {
  // 2026-06-13 정책 변경: 현재 세션 프로젝트가 아니라 user-level
  // accessiblePaths 가 일반 파일 write 경계를 결정한다. 사용자가 접근 가능한
  // 기존 프로젝트 사이의 산출물 이동은 허용하고, ghost project 생성과 접근 불가
  // 프로젝트 write 는 계속 차단한다.
  // 결정: workspace/decisions/2026-06-13-user-accessible-cross-project-file-writes.md
  const sessionRoot = '/home/tower/workspace/projects/demo-org';
  const memberAccess = [
    '/home/tower/workspace/projects/demo-org',
    '/home/tower/workspace/projects/other-project',
    '/home/tower/workspace/projects/shared',
  ];

  it('blocks member from creating a new workspace/projects/<name>/ folder', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: memberAccess,
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Bash', {
      command: `mkdir -p ${TEST_WORKSPACE_ROOT}/projects/never-existed-xyz`,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toContain('never-existed-xyz');
    }
  });

  it('allows member Write into another accessible project folder', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: memberAccess,
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Write', {
      file_path: '/home/tower/workspace/projects/other-project/AGENTS.md',
      content: 'x',
    });
    expect(result.allowed).toBe(true);
  });

  it('allows member Write into the current session project', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: memberAccess,
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Write', {
      file_path: `${sessionRoot}/strategy/notes.md`,
      content: 'x',
    });
    expect(result.allowed).toBe(true);
  });

  it('allows cross-project Bash mutation for member when the target project is accessible', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: memberAccess,
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Bash', {
      command: `cp ${sessionRoot}/file.txt /home/tower/workspace/projects/other-project/file.txt`,
    });
    expect(result.allowed).toBe(true);
  });

  it('allows member Bash mutation into shared project dropbox from another project session', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: memberAccess,
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Bash', {
      command: `cp ${sessionRoot}/file.txt /home/tower/workspace/projects/shared/incoming/file.txt`,
    });
    expect(result.allowed).toBe(true);
  });

  it('allows member Write into shared project dropbox from another project session', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: memberAccess,
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Write', {
      file_path: '/home/tower/workspace/projects/shared/incoming/notes.md',
      content: 'x',
    });
    expect(result.allowed).toBe(true);
  });

  it('allows cross-project redirect for member when the target project is accessible', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: memberAccess,
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Bash', {
      command: 'echo hi > /home/tower/workspace/projects/other-project/hi.txt',
    });
    expect(result.allowed).toBe(true);
  });

  it('allows read-only Bash commands even with a session write guard active', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: memberAccess,
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Bash', {
      command: 'ls /home/tower/workspace/projects/other-project',
    });
    expect(result.allowed).toBe(true);
  });

  it('does not treat slash-command tokens like /fleet as filesystem paths', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: memberAccess,
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Bash', {
      command: '/self-host deploy demo-server',
    });
    expect(result.allowed).toBe(true);
  });

  it.each([
    ['inline JavaScript comment', "node - <<'JS'\nconst value = 1; // comment\nJS"],
    ['HTTPS URL', 'curl -fsS https://example.com/api/health'],
    ['shell double-slash token', "printf '%s\\n' //"],
  ])('does not treat %s as an absolute filesystem path', (_label, command) => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: memberAccess,
      sessionProjectRoot: sessionRoot,
    });
    expect(guard('Bash', { command })).toEqual({ allowed: true });
  });

  it('still blocks real inaccessible absolute paths in member Bash commands', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: memberAccess,
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Bash', {
      command: 'cat /etc/passwd',
    });
    expect(result.allowed).toBe(false);
  });

  it('admin native Bash may operate on host paths with sudo', () => {
    const guard = buildToolGuard({
      role: 'admin',
      accessiblePaths: memberAccess,
      sessionProjectRoot: sessionRoot,
    });
    expect(guard('Bash', {
      command: 'sudo install -d /etc/tower-workers && systemctl daemon-reload',
    })).toEqual({ allowed: true });
  });

  it('operator may diagnose host paths but retains the sudo damage-control boundary', () => {
    const guard = buildToolGuard({
      role: 'operator',
      accessiblePaths: memberAccess,
      sessionProjectRoot: sessionRoot,
    });
    expect(guard('Bash', { command: 'cat /etc/os-release' })).toEqual({ allowed: true });
    expect(guard('Bash', { command: 'sudo install -d /etc/tower-workers' }).allowed).toBe(false);
  });

  it('keeps structured file tools project-scoped even for admin', () => {
    const guard = buildToolGuard({
      role: 'admin',
      accessiblePaths: memberAccess,
      sessionProjectRoot: sessionRoot,
    });
    expect(guard('Read', { path: '/etc/passwd' }).allowed).toBe(false);
  });

  it('blocks member direct Tower repo writes even if a path is mentioned explicitly', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: memberAccess,
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Write', {
      file_path: '/home/tower/tower/packages/backend/services/system-prompt.ts',
      content: 'x',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.message).toMatch(/Tower repo|admin/i);
  });

  it('non-project session — sessionWriteGuard is skipped, but ghostProjectGuard still blocks new ghost slug', () => {
    // Non-project sessions (cwd outside workspace/projects/) bypass the
    // session-boundary guard, but the always-on ghost project guard
    // (step 5b in buildToolGuard) takes over so admin can't silently
    // create a never-registered project folder.
    //
    // NOTE: ghost guard checks `existsSync(<slug-dir>)`, so this test must
    // use a slug that is NOT present on disk. Don't reuse `tower-brain` here
    // — the original incident left a grandfathered folder on disk that the
    // guard intentionally lets through.
    // See: workspace/decisions/2026-05-04-projects-mkdir-policy.md
    const guard = buildToolGuard({ role: 'admin' });
    const result = guard('Bash', {
      command: `mkdir -p ${TEST_WORKSPACE_ROOT}/projects/never-existed-xyz`,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toContain('[Ghost Project Guard]');
      expect(result.message).toContain('never-existed-xyz');
    }
  });
});

// ─── 2026-06-05 — admin/operator cross-project bypass on every VM ──────────
// admin/operator 는 self-hosted server 포함 모든 VM 에서 session-write 가드를 통과한다.
// customer_manager 는 Tower 전역 정책 주체가 아니므로 이 완화에 포함하지 않는다.
// Runtime Box(project_shell)는 별도: 현재 프로젝트만 mount 하므로 계속 경계 유지.
//
// 결정: workspace/decisions/2026-06-05-admin-operator-cross-project-write-on-all-vms.md
describe('buildToolGuard — admin/operator cross-project bypass (all VMs)', () => {
  const sessionRoot = '/home/tower/workspace/projects/demo-org';
  const originalRole = process.env.TOWER_ROLE;

  beforeEach(() => {
    process.env.TOWER_ROLE = 'full';
  });

  afterEach(() => {
    if (originalRole === undefined) delete process.env.TOWER_ROLE;
    else process.env.TOWER_ROLE = originalRole;
  });

  it.each(['admin', 'operator'] as const)(
    '%s on full VM → allows Write into another existing project',
    (role) => {
      const guard = buildToolGuard({
        role,
        sessionProjectRoot: sessionRoot,
      });
      // tower-ops 는 admin 의 운영 결과 디렉토리 — 실제 fleet skill 의 동기.
      const result = guard('Write', {
        file_path: '/home/tower/workspace/projects/tower-ops/runs/2026-05-27.json',
        content: '{}',
      });
      expect(result.allowed).toBe(true);
    },
  );

  it.each(['admin', 'operator'] as const)(
    '%s on full VM → allows cross-project Bash mutation',
    (role) => {
      const guard = buildToolGuard({
        role,
        sessionProjectRoot: sessionRoot,
      });
      const result = guard('Bash', {
        command: `cp ${sessionRoot}/file.txt /home/tower/workspace/projects/tower-ops/file.txt`,
      });
      expect(result.allowed).toBe(true);
    },
  );

  it('member on full VM → also allows Write into another accessible project', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: [
        '/home/tower/workspace/projects/demo-org',
        '/home/tower/workspace/projects/tower-ops',
      ],
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Write', {
      file_path: '/home/tower/workspace/projects/tower-ops/runs/x.json',
      content: 'x',
    });
    expect(result.allowed).toBe(true);
  });

  it.each(['admin', 'operator'] as const)(
    '%s on self-hosted server (TOWER_ROLE != full) → still allows cross-project Write',
    (role) => {
      process.env.TOWER_ROLE = 'managed';
      const guard = buildToolGuard({
        role,
        sessionProjectRoot: sessionRoot,
      });
      const result = guard('Write', {
        file_path: '/home/tower/workspace/projects/tower-ops/AGENTS.md',
        content: 'x',
      });
      expect(result.allowed).toBe(true);
    },
  );

  it('customer_manager on full VM → follows user-level ACL instead of session boundary', () => {
    const guard = buildToolGuard({
      role: 'customer_manager',
      accessiblePaths: [
        '/home/tower/workspace/projects/demo-org',
        '/home/tower/workspace/projects/tower-ops',
      ],
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Write', {
      file_path: '/home/tower/workspace/projects/tower-ops/runs/x.json',
      content: 'x',
    });
    expect(result.allowed).toBe(true);
  });

  it('admin/operator bypass still cannot create a new ghost project', () => {
    // 가드 완화는 *기존 프로젝트* 사이 자유 이동만. 새 ghost project 생성은
    // 변함없이 ghostProjectGuard 가 차단 (2026-05-04 정책 유지).
    const guard = buildToolGuard({
      role: 'operator',
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Bash', {
      command: `mkdir -p ${TEST_WORKSPACE_ROOT}/projects/never-existed-xyz`,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toContain('[Ghost Project Guard]');
    }
  });

  it('allows admin direct Tower repo writes', () => {
    const guard = buildToolGuard({
      role: 'admin',
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Write', {
      file_path: '/home/tower/tower/packages/backend/services/system-prompt.ts',
      content: 'x',
    });
    expect(result.allowed).toBe(true);
  });

  it('blocks operator direct Tower repo writes', () => {
    const guard = buildToolGuard({
      role: 'operator',
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Bash', {
      command: `mkdir -p ${TEST_TOWER_REPO_ROOT}/packages/backend/services/new-feature`,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.message).toMatch(/Tower repo|admin/i);
  });

  it('blocks operator git mutation in the Tower repo', () => {
    const guard = buildToolGuard({
      role: 'operator',
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Bash', {
      command: `git -C ${TEST_TOWER_REPO_ROOT} apply ${TEST_WORKSPACE_ROOT}/projects/demo-org/patch.diff`,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.message).toMatch(/Tower repo|admin/i);
  });

  it('allows operator read-only diagnostics in the Tower repo', () => {
    const guard = buildToolGuard({
      role: 'operator',
      sessionProjectRoot: sessionRoot,
    });
    const result = guard('Bash', {
      command: 'git -C /home/tower/tower status --short',
    });
    expect(result.allowed).toBe(true);
  });
});

// ─── Ghost project guard (always-on, role-independent) ────────────────────────
// Backstop for sessions where (a) cwd is outside workspace/projects/<X>/ so
// buildSessionWriteGuard doesn't apply AND (b) admin/operator permissionMode is
// 'bypassPermissions' so PreToolUse hook deny is silently ignored by the SDK.
// canUseTool callbacks always run, so this is the only enforcement that
// catches admin-from-tower-cwd ghost-mkdir attempts.
//
// Decision: workspace/decisions/2026-05-04-projects-mkdir-policy.md
describe('buildToolGuard — ghost project guard (always-on)', () => {
  const WORKSPACE = TEST_WORKSPACE_ROOT;
  const adminGuard = () => buildToolGuard({ role: 'admin' });

  it('blocks admin mkdir of a brand-new project slug', () => {
    const result = adminGuard()('Bash', {
      command: `mkdir -p ${WORKSPACE}/projects/never-existed-xyz`,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toContain('[Ghost Project Guard]');
      expect(result.message).toContain('never-existed-xyz');
      expect(result.message).toContain('tower-project-create.sh never-existed-xyz');
    }
  });

  it('blocks admin Write to a file under a new project slug (auto-mkdir parent)', () => {
    const result = adminGuard()('Write', {
      file_path: `${WORKSPACE}/projects/never-existed-xyz/notes.md`,
      content: 'x',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toContain('[Ghost Project Guard]');
    }
  });

  it('blocks admin cp into a new project slug', () => {
    const result = adminGuard()('Bash', {
      command: `cp /tmp/foo.txt ${WORKSPACE}/projects/never-existed-xyz/foo.txt`,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toContain('[Ghost Project Guard]');
    }
  });

  it('blocks admin git clone into a new project slug', () => {
    const result = adminGuard()('Bash', {
      command: `git clone https://example.com/repo.git ${WORKSPACE}/projects/never-existed-xyz`,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toContain('[Ghost Project Guard]');
    }
  });

  it('blocks admin git worktree add into a new project slug', () => {
    const result = adminGuard()('Bash', {
      command: `git worktree add ${WORKSPACE}/projects/never-existed-xyz HEAD`,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toContain('[Ghost Project Guard]');
    }
  });

  it('blocks tilde-prefixed paths (~/workspace/projects/<new>)', () => {
    const result = adminGuard()('Bash', {
      command: 'mkdir -p ~/workspace/projects/never-existed-xyz',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toContain('[Ghost Project Guard]');
    }
  });

  it('allows writes into a project slug that already exists on disk (grandfathered)', () => {
    // 'demo-org' is one of many existing project folders; treat it as a stand-in.
    // The guard checks existsSync on the slug path, so any actually-present
    // directory counts. Use a slug we know exists in this repo: '_team' or
    // 'auto-retro' (both seen in workspace/projects/).
    const result = adminGuard()('Write', {
      file_path: `${WORKSPACE}/projects/auto-retro/notes/${Date.now()}.md`,
      content: 'x',
    });
    expect(result.allowed).toBe(true);
  });

  it('allows writes into shared workspace dirs (decisions, docs, published)', () => {
    const guard = adminGuard();
    expect(guard('Write', {
      file_path: `${WORKSPACE}/decisions/2026-05-05-test.md`,
      content: 'x',
    }).allowed).toBe(true);
    expect(guard('Write', {
      file_path: `${WORKSPACE}/docs/research/topic.md`,
      content: 'x',
    }).allowed).toBe(true);
    expect(guard('Write', {
      file_path: `${WORKSPACE}/published/sites/demo/index.html`,
      content: 'x',
    }).allowed).toBe(true);
  });

  it('allows admin writes outside workspace entirely (~/tower, /tmp)', () => {
    const guard = adminGuard();
    expect(guard('Bash', {
      command: `mkdir -p ${TEST_TOWER_REPO_ROOT}/packages/backend/services/new-feature`,
    }).allowed).toBe(true);
    expect(guard('Bash', {
      command: 'mkdir -p /tmp/scratch-xyz',
    }).allowed).toBe(true);
  });

  it('allows read-only Bash commands targeting new slug paths', () => {
    // The guard only fires on mutating verbs / write tools.
    const guard = adminGuard();
    expect(guard('Bash', {
      command: `ls ${WORKSPACE}/projects/never-existed-xyz`,
    }).allowed).toBe(true);
    expect(guard('Bash', {
      command: `cat ${WORKSPACE}/projects/never-existed-xyz/foo.md`,
    }).allowed).toBe(true);
  });

  it('respects TOWER_WORKSPACE_UNRESTRICTED=1 admin escape hatch', () => {
    const prev = process.env.TOWER_WORKSPACE_UNRESTRICTED;
    process.env.TOWER_WORKSPACE_UNRESTRICTED = '1';
    try {
      const result = adminGuard()('Bash', {
        command: `mkdir -p ${WORKSPACE}/projects/never-existed-xyz`,
      });
      expect(result.allowed).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TOWER_WORKSPACE_UNRESTRICTED;
      else process.env.TOWER_WORKSPACE_UNRESTRICTED = prev;
    }
  });

  it('applies to member role too (defense in depth)', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: [`${WORKSPACE}/projects/some-existing`],
    });
    const result = guard('Bash', {
      command: `mkdir -p ${WORKSPACE}/projects/never-existed-xyz`,
    });
    expect(result.allowed).toBe(false);
    // Note: member also gets blocked by buildProjectPathEnforcement (step 7),
    // so the resulting message could be from either guard — what matters is
    // that the result is denied. We don't assert the message prefix here.
  });
});

// ─── Tower-brain incident — ghost-project regression ───────────────────────
// Full playback of the 2026-04-18 incident from a session bound to `demo-org`.
// 2026-06-13 이후 일반 cross-project file write 는 user-level ACL 로 허용하지만,
// DB에 없는 `workspace/projects/<slug>/` ghost project 생성은 계속 차단한다.
//
// See: workspace/decisions/2026-04-18-session-scoped-write-guard.md
//      workspace/decisions/2026-06-13-user-accessible-cross-project-file-writes.md
// Tag:  path-guard, safety, P2, regression

describe('Tower-brain incident regression (ghost project guard)', () => {
  const originalRole = process.env.TOWER_ROLE;
  beforeEach(() => {
    process.env.TOWER_ROLE = 'managed';
  });
  afterEach(() => {
    if (originalRole === undefined) delete process.env.TOWER_ROLE;
    else process.env.TOWER_ROLE = originalRole;
  });

  const WORKSPACE = TEST_WORKSPACE_ROOT;
  const sessionRoot = `${WORKSPACE}/projects/demo-org`;
  const orphanRoot = `${WORKSPACE}/projects/tower-brain`;

  function guardFor(role: 'admin' | 'member' = 'member') {
    return buildToolGuard({
      role,
      accessiblePaths:
        role === 'admin'
          ? undefined
          : [sessionRoot, `${WORKSPACE}/projects/other-project`, `${WORKSPACE}/docs`, `${WORKSPACE}/decisions`],
      sessionProjectRoot: sessionRoot,
    });
  }

  function expectProjectWriteBlocked(
    result: { allowed: true } | { allowed: false; message: string },
    needle = 'tower-brain',
  ) {
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // Existing-but-inaccessible grandfathered folders are blocked by the
      // user-level Project ACL; brand-new slugs are blocked by Ghost Project Guard.
      expect(result.message).toContain(needle);
    }
  }

  function expectGhostProjectBlock(
    result: { allowed: true } | { allowed: false; message: string },
    needle = 'new-invented-slug',
  ) {
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toContain('[Ghost Project Guard]');
      expect(result.message).toContain(needle);
    }
  }

  it('step 1 — mkdir workspace/projects/tower-brain/ is blocked', () => {
    const guard = guardFor('member');
    expectProjectWriteBlocked(guard('Bash', { command: `mkdir -p ${orphanRoot}` }));
  });

  it('step 1b — mkdir with trailing slash + extra flags is blocked', () => {
    const guard = guardFor('member');
    expectProjectWriteBlocked(
      guard('Bash', { command: `mkdir -pv ${orphanRoot}/` }),
    );
  });

  it('step 2 — Write AGENTS.md into the orphan folder is blocked', () => {
    const guard = guardFor('member');
    expectProjectWriteBlocked(
      guard('Write', {
        file_path: `${orphanRoot}/AGENTS.md`,
        content: '# Tower Brain\n',
      }),
    );
  });

  it('step 3 — Write .project/progress.md is blocked', () => {
    const guard = guardFor('member');
    expectProjectWriteBlocked(
      guard('Write', {
        file_path: `${orphanRoot}/.project/progress.md`,
        content: 'progress log',
      }),
    );
  });

  it('step 4 — Write a 42KB HTML business plan into the orphan folder is blocked', () => {
    const guard = guardFor('member');
    expectProjectWriteBlocked(
      guard('Write', {
        file_path: `${orphanRoot}/business-plan.html`,
        content: '<html>...</html>',
      }),
    );
  });

  it('step 5 — Edit on an orphan-folder file is blocked', () => {
    const guard = guardFor('member');
    expectProjectWriteBlocked(
      guard('Edit', {
        file_path: `${orphanRoot}/AGENTS.md`,
        old_string: 'a',
        new_string: 'b',
      }),
    );
  });

  it('step 6 — NotebookEdit into the orphan folder is blocked', () => {
    const guard = guardFor('member');
    expectProjectWriteBlocked(
      guard('NotebookEdit', {
        notebook_path: `${orphanRoot}/notebook.ipynb`,
        cell_number: 0,
        new_source: 'print(1)',
      }),
    );
  });

  it('bash redirect — `cat > tower-brain/...` is blocked', () => {
    const guard = guardFor('member');
    expectProjectWriteBlocked(
      guard('Bash', {
        command: `cat > ${orphanRoot}/AGENTS.md <<'EOF'\n# x\nEOF`,
      }),
    );
  });

  it('bash append redirect — `>>` into the orphan folder is blocked', () => {
    const guard = guardFor('member');
    expectProjectWriteBlocked(
      guard('Bash', {
        command: `echo "line" >> ${orphanRoot}/progress.md`,
      }),
    );
  });

  it('bash pipeline — `... | tee` into the orphan folder is blocked', () => {
    const guard = guardFor('member');
    expectProjectWriteBlocked(
      guard('Bash', {
        command: `curl -s https://example.com | tee ${orphanRoot}/cache.html`,
      }),
    );
  });

  it('bash install — `install -D` into the orphan folder is blocked', () => {
    const guard = guardFor('member');
    expectProjectWriteBlocked(
      guard('Bash', {
        command: `install -D /tmp/plan.md ${orphanRoot}/.project/plan.md`,
      }),
    );
  });

  it('bash rsync — syncing INTO the orphan folder is blocked', () => {
    const guard = guardFor('member');
    expectProjectWriteBlocked(
      guard('Bash', {
        command: `rsync -av ${sessionRoot}/ ${orphanRoot}/`,
      }),
    );
  });

  it('bash touch — creating a marker file inside the orphan folder is blocked', () => {
    const guard = guardFor('member');
    expectProjectWriteBlocked(
      guard('Bash', {
        command: `touch ${orphanRoot}/.keep`,
      }),
    );
  });

  it('bash mv — moving a file INTO the orphan folder is blocked', () => {
    const guard = guardFor('member');
    expectProjectWriteBlocked(
      guard('Bash', {
        command: `mv ${sessionRoot}/draft.html ${orphanRoot}/index.html`,
      }),
    );
  });

  it('member with multi-project access — still blocked from unregistered tower-brain', () => {
    // The user IS a member of `other-project`, but `tower-brain` is not in
    // accessiblePaths and therefore still counts as a ghost project.
    const guard = guardFor('member');
    expectProjectWriteBlocked(
      guard('Write', {
        file_path: `${orphanRoot}/AGENTS.md`,
        content: 'x',
      }),
    );
  });

  it('orphan creation under a different (also unregistered) name is blocked', () => {
    // Not just literal "tower-brain" — ANY unregistered workspace/projects/<x>/
    // should be blocked from the demo-org session.
    const guard = guardFor('member');
    const brandNew = `${WORKSPACE}/projects/new-invented-slug`;
    expectGhostProjectBlock(
      guard('Bash', { command: `mkdir -p ${brandNew}` }),
      'new-invented-slug',
    );
  });

  it('reading an inaccessible grandfathered orphan folder is still blocked by Project ACL', () => {
    const guard = guardFor('member');
    const result = guard('Bash', { command: `ls -la ${orphanRoot}` });
    expectProjectWriteBlocked(result);
  });

  it('member follow-up — writing to workspace/decisions/ is allowed', () => {
    // 2026-06-10 policy: members need broad working rights over shared docs/decisions.
    const guard = guardFor('member');
    const result = guard('Write', {
      file_path: `${WORKSPACE}/decisions/2026-04-21-tower-brain-regression.md`,
      content: '# note',
    });
    expect(result.allowed).toBe(true);
  });

  it('member follow-up — writing to workspace/published/ is still denied', () => {
    const guard = guardFor('member');
    const result = guard('Write', {
      file_path: `${WORKSPACE}/published/sites/demo-org-demo/index.html`,
      content: '<html></html>',
    });
    expect(result.allowed).toBe(false);
  });

  it('new ghost-project denial message includes canonical project creation hints', () => {
    const guard = guardFor('member');
    const brandNew = `${WORKSPACE}/projects/new-invented-slug`;
    const result = guard('Bash', { command: `mkdir -p ${brandNew}` });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toMatch(/Ghost Project Guard/i);
      expect(result.message).toMatch(/Sidebar/i);
      expect(result.message).toMatch(/tower-project-create/i);
      expect(result.message).toMatch(/POST \/api\/projects/i);
    }
  });
});

// ─── Workspace root isolation (2026-05-02) ───────────────────────────────────
// Decision: workspace/decisions/2026-05-02-workspace-root-isolation.md
// - admin/operator → see workspace 루트 + uploads/ + published/, write anywhere
// - member → projects + docs/decisions write, uploads/published 차단
// - viewer/guest → docs/decisions read-only, uploads/published 차단
// - dotfile/system paths → never visible to anyone via the file APIs
//
// These tests are PURE (no DB) — they exercise the synchronous gate functions
// only. Membership-aware paths (isPathAccessible / isPathWritableByRole) are
// tested for cases where they don't need DB lookup (admin/operator/dotfile).

describe('isPrivilegedRole — privileged trio (admin/operator/customer_manager)', () => {
  it('returns true for the trio, false for everyone else', () => {
    expect(isPrivilegedRole('admin')).toBe(true);
    expect(isPrivilegedRole('operator')).toBe(true);
    expect(isPrivilegedRole('customer_manager')).toBe(true); // 2026-05-27
    expect(isPrivilegedRole('member')).toBe(false);
    expect(isPrivilegedRole('guest')).toBe(false);
    expect(isPrivilegedRole('viewer')).toBe(false);
    expect(isPrivilegedRole(undefined)).toBe(false);
    expect(isPrivilegedRole(null)).toBe(false);
    expect(isPrivilegedRole('user')).toBe(false); // legacy
  });
});

describe('isAdminOrOperator — Tower 전역 관리 권한 (customer_manager 제외)', () => {
  it('returns true only for admin and operator', () => {
    expect(isAdminOrOperator('admin')).toBe(true);
    expect(isAdminOrOperator('operator')).toBe(true);
    expect(isAdminOrOperator('customer_manager')).toBe(false); // 자기 담당 customer 만
    expect(isAdminOrOperator('member')).toBe(false);
    expect(isAdminOrOperator('guest')).toBe(false);
    expect(isAdminOrOperator('viewer')).toBe(false);
    expect(isAdminOrOperator(undefined)).toBe(false);
    expect(isAdminOrOperator(null)).toBe(false);
  });
});

describe('isDotfileDenied', () => {
  it('blocks .audit, .claude, .mcp.json, .temp-uploads, .worktrees, .git', () => {
    const W = '/home/tower/workspace';
    expect(isDotfileDenied(`${W}/.audit/log.jsonl`)).toBe(true);
    expect(isDotfileDenied(`${W}/.claude/credentials`)).toBe(true);
    expect(isDotfileDenied(`${W}/.claude/settings.json`)).toBe(true);
    expect(isDotfileDenied(`${W}/.mcp.json`)).toBe(true);
    expect(isDotfileDenied(`${W}/.temp-uploads/x.png`)).toBe(true);
    expect(isDotfileDenied(`${W}/.worktrees/branch/file.ts`)).toBe(true);
    expect(isDotfileDenied(`${W}/.git/config`)).toBe(true);
  });

  it('does not block ordinary files or .env (handled by SECRET_PATH_PATTERNS)', () => {
    const W = '/home/tower/workspace';
    expect(isDotfileDenied(`${W}/principles.md`)).toBe(false);
    expect(isDotfileDenied(`${W}/projects/demo-org/AGENTS.md`)).toBe(false);
    expect(isDotfileDenied(`${W}/.env`)).toBe(false); // .env handled separately
    expect(isDotfileDenied(`${W}/decisions/d.md`)).toBe(false);
  });
});

describe('isPathAccessible — workspace root isolation', () => {
  // userId is required by the signature but irrelevant for the privileged + dotfile
  // branches we exercise here. We use 1.
  const W = process.env.WORKSPACE_ROOT || `${process.env.HOME || '/tmp'}/workspace`;

  it('admin sees everything except dotfiles', async () => {
    expect(await isPathAccessible(`${W}/principles.md`, 1, 'admin')).toBe(true);
    expect(await isPathAccessible(`${W}/uploads/contract.pdf`, 1, 'admin')).toBe(true);
    expect(await isPathAccessible(`${W}/.audit/log.jsonl`, 1, 'admin')).toBe(false); // dotfile blocks even admin
    expect(await isPathAccessible(`${W}/.mcp.json`, 1, 'admin')).toBe(false);
  });

  it('operator has the same access as admin', async () => {
    expect(await isPathAccessible(`${W}/principles.md`, 1, 'operator')).toBe(true);
    expect(await isPathAccessible(`${W}/uploads/contract.pdf`, 1, 'operator')).toBe(true);
    expect(await isPathAccessible(`${W}/.claude/credentials`, 1, 'operator')).toBe(false);
  });
});

describe('isPathWritableByRole — uploads/published/docs/decisions policy', () => {
  const W = process.env.WORKSPACE_ROOT || `${process.env.HOME || '/tmp'}/workspace`;

  it('admin, operator, customer_manager, and member can write to decisions/docs', async () => {
    for (const role of ['admin', 'operator', 'customer_manager', 'member'] as const) {
      expect(await isPathWritableByRole(`${W}/decisions/2026-05-02-x.md`, 1, role)).toBe(true);
      expect(await isPathWritableByRole(`${W}/docs/guide.md`, 1, role)).toBe(true);
    }
  });

  it('only privileged roles can write uploads/, published/, and workspace root direct files', async () => {
    for (const role of ['admin', 'operator', 'customer_manager'] as const) {
      expect(await isPathWritableByRole(`${W}/uploads/x.txt`, 1, role)).toBe(true);
      expect(await isPathWritableByRole(`${W}/published/sites/demo/index.html`, 1, role)).toBe(true);
      expect(await isPathWritableByRole(`${W}/principles.md`, 1, role)).toBe(true);
    }
    expect(await isPathWritableByRole(`${W}/uploads/x.txt`, 1, 'member')).toBe(false);
    expect(await isPathWritableByRole(`${W}/published/sites/demo/index.html`, 1, 'member')).toBe(false);
    expect(await isPathWritableByRole(`${W}/principles.md`, 1, 'member')).toBe(false);
  });

  it('viewer and guest cannot write to decisions/docs', async () => {
    for (const role of ['viewer', 'guest'] as const) {
      expect(await isPathWritableByRole(`${W}/decisions/2026-05-02-x.md`, 1, role)).toBe(false);
      expect(await isPathWritableByRole(`${W}/docs/guide.md`, 1, role)).toBe(false);
    }
  });

  it('admin/operator still blocked from dotfile/system paths', async () => {
    expect(await isPathWritableByRole(`${W}/.claude/x`, 1, 'admin')).toBe(false);
    expect(await isPathWritableByRole(`${W}/.audit/x`, 1, 'operator')).toBe(false);
    expect(await isPathWritableByRole(`${W}/.mcp.json`, 1, 'admin')).toBe(false);
  });

  // Note: member/viewer write tests for project paths require DB membership lookup;
  // those are integration-level and live elsewhere. The buildToolGuard tests below
  // exercise the same policy synchronously via accessiblePaths injection.
});

describe('buildToolGuard — shared docs/decisions policy', () => {
  // Members can READ/WRITE docs/decisions. Viewer/guest remain read-only.
  // This verifies the read-only-dirs option of buildProjectPathEnforcement
  // wired through buildToolGuard.
  const W = process.env.WORKSPACE_ROOT || `${process.env.HOME || '/tmp'}/workspace`;
  const projectRoot = `${W}/projects/demo-org`;
  const accessiblePaths = [
    projectRoot,
    `${W}/docs`,        // injected as read-only
    `${W}/decisions`,   // injected as read-only
  ];

  it('allows member to READ docs/decisions', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths,
      sessionProjectRoot: projectRoot,
    });
    const result = guard('Read', { file_path: `${W}/decisions/2026-04-26-x.md` });
    expect(result.allowed).toBe(true);
  });

  it('allows member Write into docs/', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths,
      sessionProjectRoot: projectRoot,
    });
    const result = guard('Write', { file_path: `${W}/docs/new-guide.md`, content: 'x' });
    expect(result.allowed).toBe(true);
  });

  it('allows member Write into decisions/', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths,
      sessionProjectRoot: projectRoot,
    });
    const result = guard('Write', { file_path: `${W}/decisions/2026-05-02-x.md`, content: 'x' });
    expect(result.allowed).toBe(true);
  });

  it('allows member Write into docs/decisions even with legacy allowedPath=workspace/projects', () => {
    const guard = buildToolGuard({
      role: 'member',
      allowedPath: `${W}/projects`,
      accessiblePaths,
      sessionProjectRoot: projectRoot,
    });
    expect(guard('Write', { file_path: `${W}/docs/new-guide.md`, content: 'x' }).allowed).toBe(true);
    expect(guard('Write', { file_path: `${W}/decisions/2026-05-02-x.md`, content: 'x' }).allowed).toBe(true);
  });

  it('keeps viewer/guest docs/decisions writes blocked with legacy allowedPath=workspace/projects', () => {
    for (const role of ['viewer', 'guest'] as const) {
      const guard = buildToolGuard({
        role,
        allowedPath: `${W}/projects`,
        accessiblePaths,
        sessionProjectRoot: projectRoot,
      });
      expect(guard('Write', { file_path: `${W}/docs/new-guide.md`, content: 'x' }).allowed).toBe(false);
      expect(guard('Write', { file_path: `${W}/decisions/2026-05-02-x.md`, content: 'x' }).allowed).toBe(false);
    }
  });

  it('allows member Bash mutation in docs/ (echo > file)', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths,
      sessionProjectRoot: projectRoot,
    });
    const result = guard('Bash', { command: `echo hi > ${W}/docs/note.md` });
    expect(result.allowed).toBe(true);
  });

  it('blocks viewer/guest Write into docs/decisions', () => {
    for (const role of ['viewer', 'guest'] as const) {
      const guard = buildToolGuard({
        role,
        accessiblePaths,
        sessionProjectRoot: projectRoot,
      });
      const docsResult = guard('Write', { file_path: `${W}/docs/new-guide.md`, content: 'x' });
      const decisionsResult = guard('Write', { file_path: `${W}/decisions/2026-05-02-x.md`, content: 'x' });
      expect(docsResult.allowed).toBe(false);
      expect(decisionsResult.allowed).toBe(false);
      if (!docsResult.allowed) expect(docsResult.message).toMatch(/viewer|guest|read-only/i);
    }
  });

  it('blocks guest Bash mutation in docs/ (viewer is blocked earlier by damage-control)', () => {
    const guard = buildToolGuard({
      role: 'guest',
      accessiblePaths,
      sessionProjectRoot: projectRoot,
    });
    const result = guard('Bash', { command: `echo hi > ${W}/docs/note.md` });
    expect(result.allowed).toBe(false);
  });

  it('allows operator to Write docs/ (read-only-dirs are viewer/guest-only)', () => {
    const guard = buildToolGuard({
      role: 'operator',
      // operator is privileged → accessiblePaths is null in real code; the
      // read-only-dirs guard is skipped entirely for privileged roles.
      accessiblePaths: null,
      sessionProjectRoot: projectRoot,
    });
    const result = guard('Write', { file_path: `${W}/docs/new-guide.md`, content: 'x' });
    expect(result.allowed).toBe(true);
  });

  it('allows member Edit on decisions/', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths,
      sessionProjectRoot: projectRoot,
    });
    const result = guard('Edit', {
      file_path: `${W}/decisions/2026-04-26-x.md`,
      old_string: 'a',
      new_string: 'b',
    });
    expect(result.allowed).toBe(true);
  });

  it('still allows member Write inside their own project', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths,
      sessionProjectRoot: projectRoot,
    });
    const result = guard('Write', { file_path: `${projectRoot}/notes.md`, content: 'x' });
    expect(result.allowed).toBe(true);
  });
});

describe('Bash mutator regex — tar/unzip/zip', () => {
  // The session write guard (and read-only-dirs guard) treat tar/unzip/zip as
  // mutating commands. Regression: previously a member could run
  // `tar -xf payload.tar -C ${W}/decisions/` and write files there.
  const W = process.env.WORKSPACE_ROOT || `${process.env.HOME || '/tmp'}/workspace`;
  const projectRoot = `${W}/projects/demo-org`;

  it('allows member tar extraction into decisions/', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: [projectRoot, `${W}/docs`, `${W}/decisions`],
      sessionProjectRoot: projectRoot,
    });
    const result = guard('Bash', {
      command: `tar -xf payload.tar -C ${W}/decisions/`,
    });
    expect(result.allowed).toBe(true);
  });

  it('allows member unzip into docs/', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: [projectRoot, `${W}/docs`, `${W}/decisions`],
      sessionProjectRoot: projectRoot,
    });
    const result = guard('Bash', {
      command: `unzip pack.zip -d ${W}/docs/`,
    });
    expect(result.allowed).toBe(true);
  });
});

// ─── D11 sandbox execution guard (2026-04-28, 강화 2026-05-06, 좁힘 2026-05-12) ─
// Decision: workspace/decisions/2026-05-12-d11-rule1-removal-keep-web-server-block.md
// Decision: workspace/decisions/2026-05-02-execution-sandbox-d12-sibling-sandbox-mandatory.md
//
// 현재 D11 = "본체 위 web server 차단" 한 가지. 단발 compute (python script.py 등)
// 은 본체에서 허용. 2026-05-06 사건 — demo-org AI 가 `python3 -m uvicorn main:app`
// 로 본체에 FastAPI 띄움 → 이 케이스가 가드의 *유일한* 차단 대상.
// 2026-05-12 — Rule 1 (경로 기반 차단) 폐지. 사유: refuse-to-edit reflex 환각 +
// 단발 compute 의 sandbox 강제 마찰. 자세한 트레이드오프는 결정문서 참조.

describe('buildToolGuard — D11 sandbox execution guard', () => {
  const adminGuard = () => buildToolGuard({ role: 'admin' });

  it('blocks `python3 -m uvicorn main:app` on host (Rule 2)', () => {
    const result = adminGuard()('Bash', {
      command: 'python3 -m uvicorn main:app --host 0.0.0.0 --port 8000',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toMatch(/D11|D12/);
      expect(result.message).toMatch(/sandbox/i);
      expect(result.message).toContain('mcp__sandbox__run');
    }
  });

  it('blocks `python -m gunicorn` (Rule 2)', () => {
    const result = adminGuard()('Bash', { command: 'python -m gunicorn app:app -w 4' });
    expect(result.allowed).toBe(false);
  });

  it('blocks `python -m flask run` (Rule 2)', () => {
    const result = adminGuard()('Bash', { command: 'FLASK_APP=app.py python -m flask run' });
    expect(result.allowed).toBe(false);
  });

  it('blocks `python -m http.server` (Rule 2 — historical AI fallback pattern)', () => {
    const result = adminGuard()('Bash', { command: 'python -m http.server 8080' });
    expect(result.allowed).toBe(false);
  });

  it('blocks `python3 -m hypercorn app:app` (Rule 2)', () => {
    const result = adminGuard()('Bash', { command: 'python3 -m hypercorn app:app' });
    expect(result.allowed).toBe(false);
  });

  it('still allows `python -m pip install` (Rule 2 only catches web-server modules)', () => {
    const result = adminGuard()('Bash', { command: 'python -m pip install --user pytest' });
    expect(result.allowed).toBe(true);
  });

  it('still allows `python -m unittest` (general module run)', () => {
    const result = adminGuard()('Bash', { command: 'python -m unittest discover' });
    expect(result.allowed).toBe(true);
  });

  it('still allows `python -m json.tool < a.json` (general module)', () => {
    const result = adminGuard()('Bash', { command: 'python -m json.tool < a.json' });
    expect(result.allowed).toBe(true);
  });

  // Rule 1 폐지 (2026-05-12) — 아래 세 케이스는 이제 모두 통과.
  // refuse-to-edit reflex 환각 + 단발 compute 마찰 → 본체 허용으로 단순화.
  it('now allows `python workspace/foo.py` (Rule 1 폐지 2026-05-12)', () => {
    const result = adminGuard()('Bash', { command: 'python workspace/projects/x/main.py' });
    expect(result.allowed).toBe(true);
  });

  it('now allows `node workspace/x/analyze.mjs` (Rule 1 폐지)', () => {
    const result = adminGuard()('Bash', { command: 'node workspace/projects/x/analyze.mjs' });
    expect(result.allowed).toBe(true);
  });

  it('now allows `bash ~/workspace/foo/run.sh` (Rule 1 폐지)', () => {
    const result = adminGuard()('Bash', { command: 'bash ~/workspace/projects/x/run.sh' });
    expect(result.allowed).toBe(true);
  });

  it('still allows `python /tmp/scratch.py` (non-workspace)', () => {
    const result = adminGuard()('Bash', { command: 'python /tmp/scratch.py' });
    expect(result.allowed).toBe(true);
  });

  it('still allows `python -c "print(1)"` (inline)', () => {
    const result = adminGuard()('Bash', { command: 'python -c "print(1)"' });
    expect(result.allowed).toBe(true);
  });

  it('still allows infrastructure commands (npm, docker, pm2, vite)', () => {
    expect(adminGuard()('Bash', { command: 'npm run dev' }).allowed).toBe(true);
    expect(adminGuard()('Bash', { command: 'pm2 restart tower-prod' }).allowed).toBe(true);
    expect(adminGuard()('Bash', { command: 'docker run --rm -it python:3.12' }).allowed).toBe(true);
    expect(adminGuard()('Bash', { command: 'vite build' }).allowed).toBe(true);
  });

  it('deny message includes Read/Edit disclaimer (refuse-to-edit reflex 차단)', () => {
    const result = adminGuard()('Bash', { command: 'python3 -m uvicorn main:app' });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // 워크스페이스 파일을 보거나 수정하는 것은 정상이라는 명시
      expect(result.message).toMatch(/Read \/ Edit/);
      expect(result.message).toMatch(/단발 Bash/);
    }
  });
});

describe('Secret guard — .mcp.json + broader .claude/* (2026-05-02)', () => {
  it('blocks member from reading .mcp.json (was previously unguarded)', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: ['/anywhere'],
    });
    const result = guard('Read', { file_path: '/home/x/.mcp.json' });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.message).toMatch(/MCP config|Secret Guard/i);
  });

  it('blocks member from reading .claude/settings.json (broader than credentials)', () => {
    const guard = buildToolGuard({
      role: 'member',
      accessiblePaths: ['/anywhere'],
    });
    const result = guard('Read', { file_path: '/home/x/.claude/settings.json' });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.message).toMatch(/Claude home|Secret Guard/i);
  });

  it('admin gets logged-but-allowed access to .mcp.json (legacy ops)', () => {
    const guard = buildToolGuard({ role: 'admin' });
    const result = guard('Read', { file_path: '/home/x/.mcp.json' });
    // Admin policy: log and allow (per damage-control.ts:158-160).
    expect(result.allowed).toBe(true);
  });
});
