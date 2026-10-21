import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./ChatPanel.tsx', import.meta.url), 'utf8');

describe('floating approval question layer', () => {
  it('stays above the composer without covering its controls', () => {
    expect(source).toMatch(/data-testid="floating-question-layer"[\s\S]*?top-0 bottom-\[7\.25rem\] z-30/);
    expect(source).toMatch(/bottom-\[8\.5rem\] md:px-6 md:py-6/);
    expect(source).toMatch(/<div className="relative z-20 mx-auto[\s\S]*?<InputBox/);
  });
});
