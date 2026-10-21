import { describe, expect, it } from 'vitest';
import { isAgentFirstEnabledForVm, isAIServiceEnabledForVm } from './config.js';

describe('Agent-first VM gate', () => {
  it('enables every full VM by default with an explicit rollback escape hatch', () => {
    expect(isAgentFirstEnabledForVm('full', 'true')).toBe(true);
    expect(isAgentFirstEnabledForVm('full', undefined)).toBe(true);
    expect(isAgentFirstEnabledForVm('full', '')).toBe(true);
    expect(isAgentFirstEnabledForVm('full', 'false')).toBe(false);
  });

  it('enables self-hosted VMs by default with an explicit rollback escape hatch', () => {
    expect(isAgentFirstEnabledForVm('managed', undefined)).toBe(true);
    expect(isAgentFirstEnabledForVm('managed', '')).toBe(true);
    expect(isAgentFirstEnabledForVm('managed', 'false')).toBe(false);
    expect(isAgentFirstEnabledForVm('managed', 'true')).toBe(true);
  });

  it('keeps standalone and unknown roles opt-in', () => {
    expect(isAgentFirstEnabledForVm('standalone', undefined)).toBe(false);
    expect(isAgentFirstEnabledForVm('standalone', 'true')).toBe(true);
    expect(isAgentFirstEnabledForVm(undefined, 'true')).toBe(false);
  });
});

describe('AI Service VM gate', () => {
  it('enables full and managed Agent-first VMs with an independent rollback switch', () => {
    expect(isAIServiceEnabledForVm('full', true, undefined)).toBe(true);
    expect(isAIServiceEnabledForVm('managed', true, undefined)).toBe(true);
    expect(isAIServiceEnabledForVm('managed', true, 'false')).toBe(false);
  });

  it('never bypasses Agent-first and keeps standalone explicitly opt-in', () => {
    expect(isAIServiceEnabledForVm('managed', false, 'true')).toBe(false);
    expect(isAIServiceEnabledForVm('standalone', true, undefined)).toBe(false);
    expect(isAIServiceEnabledForVm('standalone', true, 'true')).toBe(true);
    expect(isAIServiceEnabledForVm(undefined, true, 'true')).toBe(false);
  });
});
