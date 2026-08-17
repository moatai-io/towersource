import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './approval-server.ts'), 'utf8');

describe('approval MCP submission contract', () => {
  it('explicitly excludes ordinary chat questions and turn endings', () => {
    expect(source).toContain('Do NOT use for ordinary conversation questions');
    expect(source).toContain('turn endings');
  });

  it('binds requester, Project Agent Workspace, and Session from closure context', () => {
    expect(source).toContain('projectId: ctx.projectId');
    expect(source).toContain('sourceSessionId: ctx.sessionId');
    expect(source).toContain("type: 'session' as const");
  });

  it('does not claim approval automatically resumes or executes the result', () => {
    expect(source).toContain('does not prove an external action executed');
    expect(source).toContain('automatically resume a scheduled Run');
  });
});
