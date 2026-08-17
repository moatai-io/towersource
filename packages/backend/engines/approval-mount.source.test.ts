import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const claude = fs.readFileSync(path.resolve(import.meta.dirname, './claude-engine.ts'), 'utf8');
const pi = fs.readFileSync(path.resolve(import.meta.dirname, './pi/tool-assembly.ts'), 'utf8');

describe('Approval MCP visibility', () => {
  it('does not mount the approval submission tool in ordinary AI sessions', () => {
    for (const source of [claude, pi]) {
      expect(source).not.toContain('createApprovalMcpServer');
      expect(source).not.toContain('towerMcpServers.approval');
    }
  });
});
