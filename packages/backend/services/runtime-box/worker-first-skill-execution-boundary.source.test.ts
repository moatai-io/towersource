import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workerFirstSkills = [
  'skills/managed/gws/SKILL.md',
  'skills/managed/youtube-transcript/SKILL.md',
  'skills/managed/mermaid-pdf/SKILL.md',
  'skills/managed/image-slide-gen/SKILL.md',
  'skills/managed/web-capture/SKILL.md',
  'skills/managed/send-sms/SKILL.md',
  'skills/managed/goal/SKILL.md',
];

describe('Worker-first skill execution boundary', () => {
  it.each(workerFirstSkills)('%s does not select the legacy Runtime Box shell', (relativePath) => {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
    expect(source).not.toMatch(/(?:use|사용|실행|우선)[^\n]{0,80}`project_shell`/i);
    expect(source).not.toMatch(/Project Runtime Box(?:의|에서| 안에서)[^\n]{0,100}(?:실행|사용|호출|우선)/i);
    expect(source).not.toContain('runtime: runtime-box');
  });

  it('keeps compatibility execution-plane selection with Tower, not the skill', () => {
    for (const relativePath of workerFirstSkills) {
      const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
      if (source.includes('compatibility Project') || source.includes('compatibility 실행면')) {
        expect(source).toMatch(/Tower.*(?:내부적으로|처리)/);
      }
    }
  });
});
