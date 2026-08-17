import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/agent-workers.ts'), 'utf8');
const spawn = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/session/spawn-rpc.ts'), 'utf8');
const ws = fs.readFileSync(path.join(process.cwd(), 'packages/backend/routes/ws-handler.ts'), 'utf8');
const mcp = fs.readFileSync(path.join(process.cwd(), 'packages/backend/mcp/agent-worker-server.ts'), 'utf8');

describe('persistent Helper Agent model policy wiring', () => {
  it('resolves and persists the Agent execution policy before spawning', () => {
    expect(source).toContain('resolveAgentExecutionPolicy');
    expect(source).toContain('executionPolicy,');
    expect(source).toContain('model: executionPolicy?.effectiveModel || input.model');
    expect(source).toContain('effort: executionPolicy?.effectiveEffort || input.effort');
  });

  it('reuses the persisted policy for follow-up worker runs', () => {
    expect(source).toContain('worker.metadata?.executionPolicy');
    expect(source).toContain('modelPolicyRevision: executionPolicy?.revision');
    expect(source).toContain('requestedEffort: executionPolicy?.requestedEffort');
  });

  it('threads effort and policy provenance through spawned and resumed child runs', () => {
    expect(spawn).toContain('effort: req.effort');
    expect(spawn).toContain('modelPolicyId: req.modelPolicyId');
    expect(spawn).toContain('effortDowngraded: req.effortDowngraded');
    expect(spawn).toContain("req.model || null,             // pin explicit Helper model for follow-up runs");
  });

  it('accepts policy settings from file-backed Agent definitions and MCP creation', () => {
    expect(ws).toContain('modelPolicy: definition.modelPolicy');
    expect(ws).toContain('effort: definition.effort');
    expect(mcp).toContain("model_policy: z.enum(MODEL_POLICY_IDS)");
    expect(mcp).toContain("effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max'])");
  });
});
