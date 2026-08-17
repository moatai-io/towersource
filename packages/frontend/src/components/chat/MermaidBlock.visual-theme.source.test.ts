import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './MermaidBlock.tsx'), 'utf8');

describe('MermaidBlock visual theme', () => {
  it('keeps Mermaid aligned to the Tower calm teal brand accent', () => {
    expect(source).toContain("accent: '#14b8a6'");
    expect(source).toContain("accent: '#0d9488'");
    expect(source).toContain('calm teal');
    expect(source).not.toContain("accent: '#60a5fa',  // blue-400 — Tower 브랜드");
    expect(source).toContain("ctx.fillStyle = theme === 'light' ? '#ffffff' : '#071012'");
  });
});
