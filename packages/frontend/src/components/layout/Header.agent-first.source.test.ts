import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.resolve(__dirname, 'Header.tsx'), 'utf8');

describe('Header Agent-first gate', () => {
  it('requires both full role and explicit server opt-in', () => {
    expect(source).toContain("const agentFirstEnabled = useSettingsStore((s) => s.serverConfig?.agentFirstEnabled === true)");
    expect(source).toContain("const showAgentAcademyBeta = towerRole === 'full' && agentFirstEnabled");
  });

  it('does not use hostname allowlists for Agent Academy', () => {
    const gateBlock = source.slice(source.indexOf('const showAgentAcademyBeta'), source.indexOf('const handleProjectNameChange'));
    expect(gateBlock).not.toContain('window.location.hostname');
    expect(gateBlock).not.toContain('desk-dev.tower.example.com');
  });
});
