import { describe, expect, it } from 'vitest';
import { atDeployStage, DeployError, deployErrorResponse } from './deploy-error.js';

describe('publish failure diagnostics', () => {
  it.each(['source', 'detect', 'prepare', 'copy', 'provider', 'manifest', 'gateway'] as const)('classifies %s failures without exposing the cause', async stage => {
    const cause = new Error('private provider output /private/path');
    const error = await atDeployStage(stage, async () => { throw cause; }).catch(e => e);
    expect(error.cause).toBe(cause);
    const response = deployErrorResponse(error);
    expect(response.stage).toBe(stage);
    expect(response.code).toBe(`PUBLISH_${stage.toUpperCase()}_FAILED`);
    expect(response.retrySafe).toBe(false);
    expect(JSON.stringify(response)).not.toContain('private');
  });
  it('preserves classified failures and successful values', async () => {
    const error = new DeployError('copy', new Error('failure'));
    await expect(atDeployStage('provider', async () => { throw error; })).rejects.toBe(error);
    await expect(atDeployStage('copy', async () => 42)).resolves.toBe(42);
  });
  it('redacts unclassified exceptions', () => {
    expect(deployErrorResponse(new Error('private'))).toMatchObject({ code: 'PUBLISH_FAILED', stage: 'unknown', retrySafe: false });
    expect(JSON.stringify(deployErrorResponse(new Error('private')))).not.toContain('private');
  });
});
