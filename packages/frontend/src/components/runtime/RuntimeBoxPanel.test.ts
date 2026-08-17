import { describe, expect, it } from 'vitest';
import { runtimeBoxErrorPresentation, type RuntimeBox } from './RuntimeBoxPanel';

function box(overrides: Partial<RuntimeBox>): RuntimeBox {
  return {
    id: 31,
    project_id: 'project-id',
    status: 'stopped',
    ...overrides,
  };
}

describe('runtimeBoxErrorPresentation', () => {
  it('shows current failures in the danger tone', () => {
    expect(runtimeBoxErrorPresentation(box({ status: 'error', last_error: 'docker run failed' }))).toEqual({
      label: 'docker run failed',
      className: 'text-red-300',
    });
  });

  it('marks stale failures from recovered lifecycles as muted history', () => {
    expect(runtimeBoxErrorPresentation(box({ status: 'running', last_error: 'old conflict' }))).toEqual({
      label: '이전 오류(복구됨): old conflict',
      className: 'text-surface-500',
    });
  });

  it('renders nothing when there is no failure metadata', () => {
    expect(runtimeBoxErrorPresentation(box({ status: 'running', last_error: null }))).toBeNull();
  });
});
