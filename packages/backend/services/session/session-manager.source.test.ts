import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const SESSION_MANAGER_PATH = path.resolve(import.meta.dirname, './session-manager.ts');

describe('session manager deck defaults source contract', () => {
  it('keeps ungrouped sessions as null labels instead of a real Uncategorized deck', () => {
    const src = fs.readFileSync(SESSION_MANAGER_PATH, 'utf-8');
    expect(src).toContain('function normalizeSessionDeckLabel');
    expect(src).toContain("const normalizedLabel = normalizeSessionDeckLabel(label);");
    expect(src).toContain("const LEGACY_UNCATEGORIZED_DECK_LABELS = new Set(['temp', '미분류']);");
    expect(src).not.toContain("const defaultLabel = label || '미분류';");
    expect(src).not.toContain("const defaultLabel = label || 'temp';");
  });
});
