import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTHORIZATION_POLICY_ID, authorizeTowerAction } from '../authorization-policy.js';
import { authorityAcceptanceCases } from './authority-acceptance-fixtures.js';

const root = process.cwd();
const credentialRoutes = fs.readFileSync(path.join(root, 'packages/backend/routes/credential-vault-api.ts'), 'utf8');
const spawnRpc = fs.readFileSync(path.join(root, 'packages/backend/services/session/spawn-rpc.ts'), 'utf8');

describe('control-plane authority acceptance contract', () => {
  it.each(authorityAcceptanceCases)('$name', testCase => {
    expect(authorizeTowerAction(testCase)).toEqual({
      allowed: testCase.allowed,
      policyId: AUTHORIZATION_POLICY_ID,
      reason: testCase.reason,
      requiredCapability: `${testCase.resource}:${testCase.action}`,
      auditRequired: ['admin', 'reveal', 'execute', 'send', 'write'].includes(testCase.action),
    });
  });

  it('connects Session send to the owner/admin/operator service guard and diagnostic error', () => {
    expect(spawnRpc).toContain('canSendSessionMessage(req.targetSessionId, req.callerUserId, req.callerRole)');
    expect(spawnRpc).toContain('SEND_PERMISSION_DENIED (${access.reason})');
    expect(spawnRpc).not.toContain("const isAdmin = req.callerRole === 'admin'");
  });

  it('allows company managers to observe and manage company Credential originals', () => {
    expect(credentialRoutes).toMatch(/router\.get\('\/credentials',[\s\S]*?const allowed = assertOperator\(req\)/);
    const globalMutationRoutes = [
      "router.post('/credentials/api-key'",
      "router.post('/credentials/typed'",
      "router.post('/credentials/:credentialId/test'",
      "router.post('/credentials/:credentialId/rotate'",
      "router.patch('/credentials/:credentialId'",
      "router.delete('/credentials/:credentialId'",
      "router.post('/credentials/:credentialId/reveal-challenges'",
      "router.post('/credentials/:credentialId/inspect'",
      "router.post('/credentials/:credentialId/reveal'",
      "router.post('/credentials/:credentialId/compare'",
    ].filter(route => credentialRoutes.includes(route));
    expect(globalMutationRoutes.length).toBeGreaterThanOrEqual(4);
    for (const route of globalMutationRoutes) {
      const offset = credentialRoutes.indexOf(route);
      expect(credentialRoutes.slice(offset, offset + 300)).toContain('const allowed = assertOperator(req)');
    }
    const operatorGuard = credentialRoutes.match(/function assertOperator\([\s\S]*?\n}\n/)?.[0] ?? '';
    expect(operatorGuard).toContain('isAdminOrOperator(auth.role)');
  });
});
