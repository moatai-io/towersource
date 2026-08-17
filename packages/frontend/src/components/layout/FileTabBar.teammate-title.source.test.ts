import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './FileTabBar.tsx'), 'utf8');

describe('chat tab session title', () => {
  it('keeps project identity available for the chat tab avatar only', () => {
    expect(source).toContain('const project = useProjectStore');
    expect(source).toContain('<AgentIdentityAvatar project={project}');
  });

  it('does not prepend teammate names to chat tab text', () => {
    expect(source).not.toContain('const teammateName');
    expect(source).not.toContain('project?.agent?.displayName || project?.name');
    expect(source).not.toContain('{teammateName}</span>');
    expect(source).not.toContain('shrink-0 text-surface-600">·</span>');
    expect(source).toContain("{name ?? '채팅'}</span>");
  });

  it('keeps touch-sized mobile tabs without adding a second title line', () => {
    expect(source).toContain("isMobile ? 'h-12' : 'h-7'");
    expect(source).not.toContain("isMobile?'flex flex-col justify-center leading-tight'");
    expect(source).not.toContain('truncate text-[10px]');
  });
});
