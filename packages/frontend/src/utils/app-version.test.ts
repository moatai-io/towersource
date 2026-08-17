import { describe, expect, it } from 'vitest';
import { isChunkLoadError } from './app-version';

describe('isChunkLoadError', () => {
  it.each([
    "'text/html' is not a valid JavaScript MIME type.",
    'Failed to fetch dynamically imported module: /assets/MermaidBlock-old.js',
    'Expected a JavaScript-or-Wasm module script but the server responded with text/html',
    'ChunkLoadError: Loading chunk 42 failed',
  ])('recognizes stale lazy chunk errors: %s', (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  });

  it('does not classify Mermaid syntax errors as chunk errors', () => {
    expect(isChunkLoadError(new Error('Parse error on line 2'))).toBe(false);
  });
});
