import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, 'RuntimeBoxPanel.tsx'), 'utf8');

describe('RuntimeBoxPanel stale error presentation contract', () => {
  it('keeps current lifecycle failures red and marks recovered failures as history', () => {
    expect(source).toContain("box.status === 'error'");
    expect(source).toContain("className: 'text-red-300'");
    expect(source).toContain("i18n.t('runtimeBox.recoveredError'");
    expect(source).toContain("className: 'text-surface-500'");
  });

  it('does not render every last_error as an unconditional current red failure', () => {
    expect(source).toContain('runtimeBoxErrorPresentation(b)');
    expect(source).toContain('errorPresentation.className');
    expect(source).not.toContain('{b.last_error && <span className="text-red-300">{b.last_error}</span>}');
  });
});
