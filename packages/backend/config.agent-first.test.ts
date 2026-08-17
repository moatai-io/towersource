import { describe, expect, it } from 'vitest';
import { isAgentFirstEnabledForVm, isAIServiceEnabledForVm, isWorkspaceAppsEnabledForVm, resolveWorkspaceAppsMode } from './config.js';

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

describe('Workspace Apps VM gate', () => {
  it('keeps the DIY ERP Connector beta on the operator full VM only by default', () => {
    expect(isWorkspaceAppsEnabledForVm('full', undefined)).toBe(true);
    expect(isWorkspaceAppsEnabledForVm('full', '')).toBe(true);
    expect(isWorkspaceAppsEnabledForVm('full', 'false')).toBe(false);
    expect(isWorkspaceAppsEnabledForVm('managed', undefined)).toBe(false);
    expect(isWorkspaceAppsEnabledForVm('standalone', undefined)).toBe(false);
    expect(isWorkspaceAppsEnabledForVm(undefined, undefined)).toBe(false);
  });

  it('allows explicit opt-in outside the full operator VM for controlled local experiments only', () => {
    expect(isWorkspaceAppsEnabledForVm('managed', 'true')).toBe(true);
    expect(isWorkspaceAppsEnabledForVm('standalone', 'true')).toBe(true);
  });

  it('keeps local metadata as the safe default and allows the Frappe connector pilot mode', () => {
    expect(resolveWorkspaceAppsMode(undefined)).toBe('local-metadata');
    expect(resolveWorkspaceAppsMode('local-metadata')).toBe('local-metadata');
    expect(resolveWorkspaceAppsMode('frappe-connector-pilot')).toBe('frappe-connector-pilot');
    expect(resolveWorkspaceAppsMode('unknown')).toBe('local-metadata');
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
