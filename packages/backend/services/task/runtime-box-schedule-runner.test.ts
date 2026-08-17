import { describe, expect, it } from 'vitest';
import { toBoxCwd } from './runtime-box-schedule-runner.js';

describe('toBoxCwd', () => {
  it('defaults to /workspace', () => {
    expect(toBoxCwd()).toBe('/workspace');
    expect(toBoxCwd('.')).toBe('/workspace');
  });

  it('maps project-relative paths under /workspace', () => {
    expect(toBoxCwd('scripts')).toBe('/workspace/scripts');
    expect(toBoxCwd('scripts/../reports')).toBe('/workspace/reports');
  });

  it('accepts /workspace absolute paths', () => {
    expect(toBoxCwd('/workspace/scripts')).toBe('/workspace/scripts');
  });

  it('rejects host absolute paths', () => {
    expect(() => toBoxCwd('/home/tower/workspace/projects/foo')).toThrow(/project-relative/);
  });

  it('rejects traversal above /workspace', () => {
    expect(() => toBoxCwd('../other')).toThrow(/escapes/);
    expect(() => toBoxCwd('/workspace/../etc')).toThrow(/escapes/);
  });
});
