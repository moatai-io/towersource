import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSecretGuard } from './damage-control.ts';

describe('buildSecretGuard — non-admin', () => {
  const guard = buildSecretGuard('member');

  it('blocks Read of .env', () => {
    const r = guard('Read', { file_path: '/home/u/app/.env' });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.message).toMatch(/\.env file/);
  });

  it('blocks Read of .env.production', () => {
    const r = guard('Read', { file_path: '/home/u/app/.env.production' });
    expect(r.allowed).toBe(false);
  });

  it('allows .env.example (template)', () => {
    const r = guard('Read', { file_path: '/home/u/app/.env.example' });
    expect(r.allowed).toBe(true);
  });

  it('allows .env.sample / .env.template', () => {
    expect(guard('Read', { file_path: '/x/.env.sample' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/x/.env.template' }).allowed).toBe(true);
  });

  it('blocks credentials.json', () => {
    const r = guard('Read', { file_path: '/home/u/credentials.json' });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.message).toMatch(/credentials JSON/);
  });

  it('blocks claude credentials', () => {
    const r = guard('Read', { file_path: '/home/u/.claude/credentials.json' });
    expect(r.allowed).toBe(false);
  });

  it('blocks SSH private keys', () => {
    const r = guard('Read', { file_path: '/home/u/.ssh/id_ed25519' });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.message).toMatch(/SSH private key/);
  });

  it('allows SSH public keys', () => {
    expect(guard('Read', { file_path: '/home/u/.ssh/id_ed25519.pub' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.ssh/known_hosts' }).allowed).toBe(true);
  });

  it('blocks Bash cat .env', () => {
    const r = guard('Bash', { command: 'cat /home/u/app/.env' });
    expect(r.allowed).toBe(false);
  });

  it('blocks Bash with credentials path embedded', () => {
    const r = guard('Bash', { command: 'cp /home/u/.aws/credentials /tmp/x' });
    expect(r.allowed).toBe(false);
  });

  it('allows benign Bash unrelated to secrets', () => {
    expect(guard('Bash', { command: 'ls -la /tmp' }).allowed).toBe(true);
    expect(guard('Bash', { command: 'echo hello' }).allowed).toBe(true);
  });

  it('allows non-secret file paths', () => {
    expect(guard('Read', { file_path: '/home/u/app/index.ts' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/app/package.json' }).allowed).toBe(true);
  });
});

describe('buildSecretGuard — admin gets logged-but-allowed', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const guard = buildSecretGuard('admin');

  it('allows .env for admin and warns', () => {
    const r = guard('Read', { file_path: '/home/u/app/.env' });
    expect(r.allowed).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/admin accessed.*\.env/));
  });

  it('allows credentials for admin and warns', () => {
    const r = guard('Bash', { command: 'cat /home/u/.aws/credentials' });
    expect(r.allowed).toBe(true);
    expect(console.warn).toHaveBeenCalled();
  });

  it('does not warn on non-secret path', () => {
    vi.clearAllMocks();
    const r = guard('Read', { file_path: '/home/u/app/index.ts' });
    expect(r.allowed).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe('buildSecretGuard — viewer also blocked', () => {
  const guard = buildSecretGuard('viewer');

  it('blocks .env for viewer too', () => {
    const r = guard('Read', { file_path: '/home/u/app/.env' });
    expect(r.allowed).toBe(false);
  });
});

// ── .claude/ allowlist for skill fixed-entry-points ─────────────────────────
// See workspace/decisions/2026-05-07-secret-guard-claude-allowlist.md.
// These paths are inside .claude/ but verified to hold no secrets, so
// non-admin sessions need to be able to read/exec them.
describe('buildSecretGuard — .claude allowlist (non-admin can use)', () => {
  const guard = buildSecretGuard('member');

  it('allows legacy browser lifecycle scripts only as compatibility paths', () => {
    expect(guard('Bash', { command: 'bash /home/u/.claude/scripts/browser-live-start.sh' }).allowed).toBe(true);
    expect(guard('Bash', { command: 'bash ~/.claude/scripts/browser-live-stop.sh' }).allowed).toBe(true);
  });

  it('allows neko lifecycle scripts (browser-live skill)', () => {
    expect(guard('Bash', { command: 'bash /home/u/.claude/scripts/neko-start.sh' }).allowed).toBe(true);
    expect(guard('Bash', { command: 'bash /home/u/.claude/scripts/neko-stop.sh' }).allowed).toBe(true);
  });

  it('allows memory hooks (memory skill — project-scoped store)', () => {
    expect(guard('Bash', { command: 'node /home/u/.claude/hooks/memory/search.mjs query' }).allowed).toBe(true);
  });

  it('allows /fleet entry points', () => {
    expect(guard('Bash', { command: 'bash /home/u/.claude/skills/library/deploy-profile.sh' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/library/library.yaml' }).allowed).toBe(true);
  });

  it('allows SKILL.md scanning across skills', () => {
    expect(guard('Read', { file_path: '/home/u/.claude/skills/web-capture/SKILL.md' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/fleet/SKILL.md' }).allowed).toBe(true);
  });

  it('allows plugin assets (offer-plan)', () => {
    expect(guard('Read', { file_path: '/home/u/.claude/plugins/offer-plan/logo1.png' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.claude/plugins/offer-plan/README.md' }).allowed).toBe(true);
  });

  // Negative cases — allowlist must NOT swallow real secrets under .claude/
  it('still blocks .claude/credentials.json', () => {
    expect(guard('Read', { file_path: '/home/u/.claude/credentials.json' }).allowed).toBe(false);
  });

  it('still blocks .claude/.claude.json (settings with API keys)', () => {
    expect(guard('Read', { file_path: '/home/u/.claude/.claude.json' }).allowed).toBe(false);
  });

  it('still blocks .claude/projects/ session transcripts', () => {
    // Past chats can contain user-pasted secrets — explicitly NOT allowlisted.
    expect(guard('Read', { file_path: '/home/u/.claude/projects/encoded/sessions-index.json' }).allowed).toBe(false);
    expect(guard('Bash', { command: 'cat /home/u/.claude/projects/foo/abc.jsonl' }).allowed).toBe(false);
  });

  it('still blocks arbitrary script names with non-allowed extensions', () => {
    // Allowlist for scripts/ requires .sh/.mjs/.js/.py — anything else falls through
    expect(guard('Read', { file_path: '/home/u/.claude/scripts/secrets.env' }).allowed).toBe(false);
  });

  it('still blocks .claude/scripts/ subdirectories not on allowlist', () => {
    // Defense-in-depth — allowlist matches files directly, not nested paths
    expect(guard('Read', { file_path: '/home/u/.claude/scripts/private/.env' }).allowed).toBe(false);
  });
});

// ── 2026-05-23 expansion — skill read-only guides / templates / examples ────
// See workspace/decisions/2026-05-23-secret-guard-skill-readonly-allowlist.md.
// Skills carry reference.md / templates/ / examples/ / assets/ as read-only
// usage docs and data — guest/member need read access to use the skill.
// ABSOLUTE_SECRET_PATTERNS still catch any .env / credentials accidentally
// dropped inside those folders.
describe('buildSecretGuard — skill read-only allowlist (2026-05-23 expansion)', () => {
  const guard = buildSecretGuard('member');

  // ── Positive: member can now read these ───────────────────────────────────
  it('allows skill reference.md (pptx-template case)', () => {
    expect(guard('Read', { file_path: '/home/u/.claude/skills/pptx-template/reference.md' }).allowed).toBe(true);
  });

  it('allows skill README / GUIDE / USAGE / CHANGELOG / NOTES / SCHEMA / HANDBOOK .md', () => {
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/README.md' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/GUIDE.md' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/USAGE.md' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/CHANGELOG.md' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/NOTES.md' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/SCHEMA.md' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/HANDBOOK.md' }).allowed).toBe(true);
  });

  it('allows lowercase reference.md too (case-insensitive)', () => {
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/reference.md' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/readme.md' }).allowed).toBe(true);
  });

  it('allows templates/ folder contents (PPTX templates, fonts, etc.)', () => {
    expect(guard('Read', { file_path: '/home/u/.claude/skills/pptx-template/templates/brand.pptx' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/offer-A4-html/templates/cover.html' }).allowed).toBe(true);
  });

  it('allows examples/ and samples/ folders', () => {
    expect(guard('Read', { file_path: '/home/u/.claude/skills/svg/examples/hero.svg' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/samples/data.json' }).allowed).toBe(true);
  });

  it('allows references/ and assets/ and data/ and fixtures/ folders', () => {
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/references/spec.md' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/assets/logo.png' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/data/lookup.csv' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/fixtures/sample.json' }).allowed).toBe(true);
  });

  it('allows scripts/ data files (.yaml/.json/.md/.txt/.csv/.toml)', () => {
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/scripts/config.yaml' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/scripts/data.json' }).allowed).toBe(true);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/scripts/notes.md' }).allowed).toBe(true);
  });

  // ── Negative: ABSOLUTE secrets still blocked even inside allowlisted folders ─
  it('STILL blocks .env even inside templates/', () => {
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/templates/.env' }).allowed).toBe(false);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/templates/.env.production' }).allowed).toBe(false);
  });

  it('STILL blocks credentials.json inside any skill folder', () => {
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/templates/credentials.json' }).allowed).toBe(false);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/scripts/api-credentials.json' }).allowed).toBe(false);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/assets/credentials.json' }).allowed).toBe(false);
  });

  it('STILL blocks SSH keys when referenced via .ssh/ path', () => {
    // SSH key pattern requires `.ssh/` in path (intentional — only the canonical
    // ~/.ssh/ location is treated as secret). A bare `id_ed25519` filename
    // placed elsewhere is not caught by this rule — the ABSOLUTE patterns are
    // conservative on purpose. See decision file for follow-up lint discussion.
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/assets/.ssh/id_ed25519' }).allowed).toBe(false);
  });

  it('STILL blocks .mcp.json inside skill folders', () => {
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/.mcp.json' }).allowed).toBe(false);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/templates/.mcp.json' }).allowed).toBe(false);
  });

  // ── Negative: arbitrary .md filenames at skill root still blocked ─────────
  it('blocks arbitrary .md filenames at skill root not on guide whitelist', () => {
    // Only the explicit names (reference/README/GUIDE/...) pass — arbitrary
    // .md (e.g. someone naming a file 'api-keys.md') falls through.
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/api-keys.md' }).allowed).toBe(false);
    expect(guard('Read', { file_path: '/home/u/.claude/skills/foo/secrets.md' }).allowed).toBe(false);
  });

  // ── Negative: .claude/ outside skills/ still gated as before ──────────────
  it('still blocks .claude/credentials.json (skill expansion is scoped to skills/)', () => {
    expect(guard('Read', { file_path: '/home/u/.claude/credentials.json' }).allowed).toBe(false);
  });

  it('still blocks .claude/projects/<encoded>/<uuid>.jsonl (session transcripts)', () => {
    expect(guard('Read', { file_path: '/home/u/.claude/projects/foo/abc.jsonl' }).allowed).toBe(false);
  });
});
