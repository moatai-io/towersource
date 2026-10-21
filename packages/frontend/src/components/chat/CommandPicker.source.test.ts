import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const SOURCE_PATH = path.resolve(__dirname, 'CommandPicker.tsx');

describe('CommandPicker layout contract', () => {
  it('renders through a fixed body portal outside chat overflow boundaries', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf-8');

    expect(source).toContain("import { createPortal } from 'react-dom'");
    expect(source).toContain('document.body');
    expect(source).toContain('data-testid="slash-command-picker"');
    expect(source).toContain('className="fixed z-[1000] overflow-y-auto overscroll-contain');
    expect(source).toContain('anchor.getBoundingClientRect()');
    expect(source).toContain('window.visualViewport?.height || window.innerHeight');
    expect(source).toContain('maxHeight: Math.min(768, Math.floor(availableAbove * 0.92))');
    expect(source).toContain("window.addEventListener('scroll', updatePosition, true)");
  });

  it('distinguishes commands, skills, and workflows with glyphs and text labels', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf-8');

    expect(source).toContain("return '✦'");
    expect(source).toContain("return '▶'");
    expect(source).toContain("return '›_'");
    expect(source).toContain("return 'skill'");
    expect(source).toContain("return 'flow'");
    expect(source).toContain("return 'cmd'");
    expect(source).toContain('kindTone(cmd)');
  });
});
