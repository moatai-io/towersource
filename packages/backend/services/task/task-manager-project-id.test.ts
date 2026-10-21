import { describe, expect, it } from 'vitest';
import {
  normalizeTaskProjectId,
  SYSTEM_PROJECT_SENTINEL_ID,
} from './task-manager.js';

describe('Task project id normalization', () => {
  it('maps the system project sentinel to a nullable Task project reference', () => {
    expect(normalizeTaskProjectId(SYSTEM_PROJECT_SENTINEL_ID)).toBeNull();
  });

  it('preserves real project ids', () => {
    expect(normalizeTaskProjectId('project-1')).toBe('project-1');
  });

  it('preserves undefined so createTask can resolve a project from cwd', () => {
    expect(normalizeTaskProjectId(undefined)).toBeUndefined();
  });

  it('preserves explicit null for system or personal Tasks', () => {
    expect(normalizeTaskProjectId(null)).toBeNull();
  });
});
