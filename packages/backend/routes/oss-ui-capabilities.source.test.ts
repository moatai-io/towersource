import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const api = fs.readFileSync(path.resolve(import.meta.dirname, './api.ts'), 'utf8');
const preview = fs.readFileSync(path.resolve(import.meta.dirname, '../../frontend/src/components/files/AgentDraftPreview.tsx'), 'utf8');

describe('deployment-profile UI capability contract', () => {
  it('computes optional-connection prominence on the server', () => {
    expect(api).toContain('uiCapabilities: {');
    expect(api).toContain("config.towerRole === 'full' ? 'inline'");
    expect(api).toContain("config.towerRole === 'managed' ? 'optional' : 'hidden'");
  });

  it('keeps the Agent creation component role-agnostic', () => {
    expect(preview).toContain('serverConfig?.uiCapabilities?.agentCreation?.googleConnection');
    expect(preview).not.toContain("towerRole === 'standalone'");
    expect(preview).not.toContain("towerRole === 'full'");
  });
});
