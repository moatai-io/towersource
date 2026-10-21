import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'InputBox.tsx'), 'utf8');

describe('InputBox mobile keyboard behavior', () => {
  it('does not issue a delayed smooth scroll after focus because iOS already pans the visual viewport', () => {
    expect(source).not.toContain("scrollIntoView({ block: 'end', behavior: 'smooth' })");
    expect(source).not.toMatch(/onFocus=\{\(e\) => \{[\s\S]*?setTimeout/);
  });
});
