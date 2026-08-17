import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const script = fs.readFileSync(path.join(root, 'packages/backend/scripts/ai-service-public-channel-smoke.ts'), 'utf8');
const workspaceRoot = process.env.WORKSPACE_ROOT || path.join(os.homedir(), 'workspace');
const runbookPath = path.join(workspaceRoot, 'docs/ai-service-public-channel-smoke-runbook.md');
const decisionPath = path.join(workspaceRoot, 'decisions/2026-07-15-ai-service-public-channel-smoke-runbook.md');

describe('AI Service public Channel smoke operator contract', () => {
  it('provides an explicit npm smoke command that is not part of generic preflight', () => {
    expect(packageJson.scripts['smoke:ai-service-public-channel']).toContain('ai-service-public-channel-smoke.ts');
    expect(packageJson.scripts.preflight).not.toContain('smoke:ai-service-public-channel');
    expect(packageJson.scripts.test).not.toContain('ai-service-public-channel-smoke');
  });

  it('keeps the smoke focused on public serving evidence without activation mutation', () => {
    expect(script).toContain('evaluationCountBefore');
    expect(script).toContain('evaluationCountAfter');
    expect(script).toContain('revocationBlocked');
    expect(script).toContain('issueChannelCredential');
    expect(script).toContain('runAIServiceChannelTurn');
    expect(script).not.toContain('recordPassedRuntimeEvaluation');
    expect(script).not.toContain('activateDeployment(');
  });

  it('documents operator preconditions, success criteria, and CI exclusion when workspace docs are mounted', () => {
    // Operator docs intentionally live outside the source repo. Generic CI and
    // pre-push temp worktrees must not fail merely because that workspace is not mounted.
    if (!fs.existsSync(runbookPath) || !fs.existsSync(decisionPath)) return;

    const runbook = fs.readFileSync(runbookPath, 'utf8');
    const decision = fs.readFileSync(decisionPath, 'utf8');
    expect(runbook).toContain('Do **not** add this smoke to ordinary `npm test` or preflight');
    expect(runbook).toContain('evaluationCountBefore === evaluationCountAfter');
    expect(runbook).toContain('revocationBlocked === true');
    expect(decision).toContain('operator-run smoke command');
    expect(decision).toContain('Why not ordinary CI yet?');
  });
});
