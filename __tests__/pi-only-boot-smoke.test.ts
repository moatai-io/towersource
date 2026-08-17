import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Pi-only boot smoke test.
 *
 * Goal: catch the failure mode where a new code path top-level-imports something
 * that requires Claude credentials or the Claude CLI, which would silently break
 * Pi-only customer deployments (CLAUDE_ENABLED=false, no ~/.claude/.credentials.json).
 *
 * We don't boot the HTTP server — index.ts has side effects (listen, PG init,
 * scheduler start) that aren't appropriate for a fast unit test. Instead we
 * dynamically import each of backend/index.ts's top-level dependencies under a
 * Pi-only environment and assert each one loads cleanly.
 *
 * If this suite goes red, the usual culprit is someone adding
 * `import { foo } from '@anthropic-ai/claude-agent-sdk'` (or a module that does
 * the same transitively + requires creds at import time) at the top of a file
 * that is always imported regardless of CLAUDE_ENABLED. Fix: move that import
 * inside a function, or guard it behind a `config.claudeEnabled` check.
 *
 * Related: workspace/decisions/2026-04-21-fresh-install-scaffolding-audit.md
 *          workspace/decisions/2026-04-21-demo-server-pi-only-deployment.md
 */

describe('pi-only boot smoke', () => {
  beforeAll(() => {
    // Pi-only environment — matches demo-server.tower.example.com config.
    process.env.CLAUDE_ENABLED = 'false';
    process.env.PI_ENABLED = 'true';
    process.env.DEFAULT_ENGINE = 'pi';
    // Strip any Claude creds that might leak from the operator host's env.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDECODE;
    // JWT_SECRET is required by validateConfig() — feed a dummy value so
    // config.ts imports don't reject.
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pi-only-smoke-do-not-use-in-prod';
  });

  // Each entry is a top-level dependency of packages/backend/index.ts.
  // Keep this list in sync with index.ts's top-of-file imports — if someone
  // adds a new top-level import there, add it here too.
  const topLevelModules = [
    '../packages/backend/config.js',
    '../packages/backend/routes/api.js',
    '../packages/backend/routes/gateway.js',
    '../packages/backend/routes/ws-handler.js',
    '../packages/backend/db/pg.js',
    '../packages/backend/services/workspace/file-system.js',
    '../packages/backend/services/git/git-manager.js',
    '../packages/backend/services/task/task-runner.js',
    '../packages/backend/services/ai/claude-sdk.js',
    '../packages/backend/services/ai/pi-session-runtime.js',
    '../packages/backend/services/task/unified-scheduler.js',
    '../packages/backend/services/notification-hub.js',
    '../packages/backend/services/session/session-manager.js',
    '../packages/backend/services/ws-sync.js',
    '../packages/backend/services/skill/skill-registry.js',
    '../packages/backend/services/task/task-manager.js',
    '../packages/backend/services/pm/project-manager.js',
    '../packages/backend/engines/index.js',
  ] as const;

  it.each(topLevelModules)(
    'imports %s without error under CLAUDE_ENABLED=false',
    async (modulePath) => {
      await expect(import(modulePath)).resolves.toBeDefined();
    },
    15_000,
  );

  it('engines/index.ts refuses to construct Claude engine when disabled', async () => {
    const { getEngine } = await import('../packages/backend/engines/index.js');
    await expect(getEngine('claude')).rejects.toThrow(/disabled|archived/i);
  });

  it('engines/index.ts constructs Pi engine without importing Claude engine module', async () => {
    const { getEngine } = await import('../packages/backend/engines/index.js');
    const engine = await getEngine('pi');
    expect(engine).toBeDefined();
    expect(typeof engine.getActiveCount).toBe('function');
    expect(typeof engine.getRunningSessionIds).toBe('function');
  }, 15_000);
});
