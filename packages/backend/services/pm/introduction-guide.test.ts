import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INTRODUCTION_GUIDES, INTRODUCTION_INSTRUCTION, seedIntroductionGuides } from './introduction-guide.js';

describe('Introduction starter guidance', () => {
  it('provides linked user topics and concrete automation examples without promising execution', () => {
    expect(Object.keys(INTRODUCTION_GUIDES)).toEqual(expect.arrayContaining(['START-HERE.md', 'automations.md', 'permissions-and-privacy.md']));
    for (const file of Object.keys(INTRODUCTION_GUIDES).filter(name => name !== 'START-HERE.md')) {
      expect(INTRODUCTION_GUIDES['START-HERE.md']).toContain(`(${file})`);
    }
    expect(INTRODUCTION_GUIDES['automations.md']).toContain('사용자 확인');
    expect(INTRODUCTION_INSTRUCTION).toContain('승인 없이 등록하거나 실행하지 마세요');
  });

  it('creates missing guide files but preserves locally customized guidance', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-introduction-guide-'));
    try {
      seedIntroductionGuides(root);
      const first = path.join(root, 'docs', 'START-HERE.md');
      fs.writeFileSync(first, 'organization version');
      fs.unlinkSync(path.join(root, 'docs', 'automations.md'));
      seedIntroductionGuides(root);
      expect(fs.readFileSync(first, 'utf8')).toBe('organization version');
      expect(fs.readFileSync(path.join(root, 'docs', 'automations.md'), 'utf8')).toBe(INTRODUCTION_GUIDES['automations.md']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
