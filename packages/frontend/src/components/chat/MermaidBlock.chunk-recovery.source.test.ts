import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./MermaidBlock.tsx', import.meta.url), 'utf8');

describe('Mermaid stale chunk recovery contract', () => {
  it('treats an internal dynamic-import failure as an app version mismatch', () => {
    expect(source).toContain("import { isChunkLoadError, recoverFromChunkLoadError } from '../../utils/app-version'");
    expect(source).toContain('if (isChunkLoadError(e) && recoverFromChunkLoadError()) return;');
  });

  it('keeps ordinary Mermaid render failures visible', () => {
    const recovery = source.indexOf('if (isChunkLoadError(e) && recoverFromChunkLoadError()) return;');
    const visibleError = source.indexOf('setError(msg);', recovery);
    expect(recovery).toBeGreaterThan(-1);
    expect(visibleError).toBeGreaterThan(recovery);
  });
});
