import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./RichContent.tsx', import.meta.url), 'utf8');

describe('RichContent lazy loading boundaries', () => {
  it('keeps visual block chunks demand-driven during session startup', () => {
    expect(source).not.toContain('requestIdleCallback');
    expect(source).not.toMatch(/scheduleIdle\([\s\S]*import\('\.\.\/chat\/ChartBlock'\)/);
    expect(source).toContain("const ChartBlock = React.lazy(() => import('../chat/ChartBlock'));");
  });
});
