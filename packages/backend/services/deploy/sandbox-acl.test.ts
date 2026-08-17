import { describe, it, expect } from 'vitest';
import { checkSandboxWorkspaceAllowed } from './sandbox-acl.js';

const WORKSPACE = '/home/tower/workspace';
const PREFIXES = ['sandbox-tools/', 'projects/'];

describe('checkSandboxWorkspaceAllowed — privileged roles', () => {
  it('admin bypasses all checks (any path)', () => {
    expect(
      checkSandboxWorkspaceAllowed({
        role: 'admin',
        workspacePath: 'projects/some-other-users-project',
        allowedPrefixes: PREFIXES,
        workspaceRoot: WORKSPACE,
        accessiblePaths: null,
      }),
    ).toEqual({ allowed: true });
  });

  it('operator bypasses all checks (any path)', () => {
    expect(
      checkSandboxWorkspaceAllowed({
        role: 'operator',
        workspacePath: 'projects/anything',
        allowedPrefixes: PREFIXES,
        workspaceRoot: WORKSPACE,
        accessiblePaths: null,
      }),
    ).toEqual({ allowed: true });
  });

  it('admin can mount paths outside the prefix list (e.g. /tmp)', () => {
    // Admin bypasses prefix check too — only non-privileged roles see the prefix gate.
    const r = checkSandboxWorkspaceAllowed({
      role: 'admin',
      workspacePath: '/etc',
      allowedPrefixes: PREFIXES,
      workspaceRoot: WORKSPACE,
      accessiblePaths: null,
    });
    expect(r.allowed).toBe(true);
  });
});

describe('checkSandboxWorkspaceAllowed — prefix whitelist (member)', () => {
  it('rejects path outside any allowed prefix', () => {
    const r = checkSandboxWorkspaceAllowed({
      role: 'member',
      workspacePath: 'docs/guide.md',
      allowedPrefixes: PREFIXES,
      workspaceRoot: WORKSPACE,
      accessiblePaths: [`${WORKSPACE}/projects/alpha`],
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toContain('not in allowed prefixes');
      expect(r.reason).toContain('member');
    }
  });

  it('accepts sandbox-tools/<id>/ without project membership check', () => {
    // Mode C tool start owns the sandbox-tools/<id>/ folder; ownership
    // is enforced by tool-id ownership at the SQL layer, not here.
    const r = checkSandboxWorkspaceAllowed({
      role: 'member',
      workspacePath: 'sandbox-tools/42/src',
      allowedPrefixes: PREFIXES,
      workspaceRoot: WORKSPACE,
      accessiblePaths: [], // intentionally empty — not a project
    });
    expect(r.allowed).toBe(true);
  });
});

describe('checkSandboxWorkspaceAllowed — project membership (Phase 2)', () => {
  const ALPHA = `${WORKSPACE}/projects/alpha`;
  const BRAVO = `${WORKSPACE}/projects/bravo`;

  it('accepts member-owned project (alpha is in accessiblePaths)', () => {
    const r = checkSandboxWorkspaceAllowed({
      role: 'member',
      workspacePath: 'projects/alpha',
      allowedPrefixes: PREFIXES,
      workspaceRoot: WORKSPACE,
      accessiblePaths: [ALPHA],
    });
    expect(r.allowed).toBe(true);
  });

  it('accepts subdirectory of an accessible project', () => {
    const r = checkSandboxWorkspaceAllowed({
      role: 'member',
      workspacePath: 'projects/alpha/experiments/v3',
      allowedPrefixes: PREFIXES,
      workspaceRoot: WORKSPACE,
      accessiblePaths: [ALPHA],
    });
    expect(r.allowed).toBe(true);
  });

  it('accepts project the user was INVITED to (multi-membership)', () => {
    // Core scenario: member joined `bravo` via project_members table.
    // getUserAccessiblePaths returns both alpha (own) and bravo (invited).
    const r = checkSandboxWorkspaceAllowed({
      role: 'member',
      workspacePath: 'projects/bravo/scripts',
      allowedPrefixes: PREFIXES,
      workspaceRoot: WORKSPACE,
      accessiblePaths: [ALPHA, BRAVO],
    });
    expect(r.allowed).toBe(true);
  });

  it('rejects project the user is NOT a member of (the regression Phase 2 closes)', () => {
    // Pre-Phase-2 behavior: prefix-only check would let `projects/charlie` through
    // for any member. After this change, charlie is rejected unless invited.
    const r = checkSandboxWorkspaceAllowed({
      role: 'member',
      workspacePath: 'projects/charlie',
      allowedPrefixes: PREFIXES,
      workspaceRoot: WORKSPACE,
      accessiblePaths: [ALPHA, BRAVO], // user is member of alpha + bravo, NOT charlie
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toContain('charlie');
      expect(r.reason).toMatch(/not a member/i);
    }
  });

  it('rejects subdirectory of a non-member project', () => {
    const r = checkSandboxWorkspaceAllowed({
      role: 'member',
      workspacePath: 'projects/charlie/secret/data.csv',
      allowedPrefixes: PREFIXES,
      workspaceRoot: WORKSPACE,
      accessiblePaths: [ALPHA],
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toMatch(/not a member/i);
    }
  });

  it('rejects when user has zero accessible projects', () => {
    const r = checkSandboxWorkspaceAllowed({
      role: 'member',
      workspacePath: 'projects/alpha',
      allowedPrefixes: PREFIXES,
      workspaceRoot: WORKSPACE,
      accessiblePaths: [],
    });
    expect(r.allowed).toBe(false);
  });

  it('rejects path that LOOKS like an accessible project via prefix collision', () => {
    // 'projects/alpha-evil' must NOT be accepted just because 'projects/alpha' is.
    // The startsWith(root + path.sep) check guards against this.
    const r = checkSandboxWorkspaceAllowed({
      role: 'member',
      workspacePath: 'projects/alpha-evil',
      allowedPrefixes: PREFIXES,
      workspaceRoot: WORKSPACE,
      accessiblePaths: [ALPHA],
    });
    expect(r.allowed).toBe(false);
  });

  it('rejects empty / dot project slug', () => {
    const r1 = checkSandboxWorkspaceAllowed({
      role: 'member',
      workspacePath: 'projects/',
      allowedPrefixes: PREFIXES,
      workspaceRoot: WORKSPACE,
      accessiblePaths: [ALPHA],
    });
    expect(r1.allowed).toBe(false);

    const r2 = checkSandboxWorkspaceAllowed({
      role: 'member',
      workspacePath: 'projects/../etc/passwd',
      allowedPrefixes: PREFIXES,
      workspaceRoot: WORKSPACE,
      accessiblePaths: [ALPHA],
    });
    expect(r2.allowed).toBe(false);
  });
});

describe('checkSandboxWorkspaceAllowed — viewer role', () => {
  it('treats viewer like member (same membership-required policy)', () => {
    const r1 = checkSandboxWorkspaceAllowed({
      role: 'viewer',
      workspacePath: 'projects/alpha',
      allowedPrefixes: PREFIXES,
      workspaceRoot: WORKSPACE,
      accessiblePaths: [`${WORKSPACE}/projects/alpha`],
    });
    expect(r1.allowed).toBe(true);

    const r2 = checkSandboxWorkspaceAllowed({
      role: 'viewer',
      workspacePath: 'projects/charlie',
      allowedPrefixes: PREFIXES,
      workspaceRoot: WORKSPACE,
      accessiblePaths: [`${WORKSPACE}/projects/alpha`],
    });
    expect(r2.allowed).toBe(false);
  });
});
