import { describe, expect, it } from 'vitest';
import { classifyWorkbenchToolAcquisition } from './workbench-tool-acquisition-policy.js';

const base = {
  capability: 'document-processing' as const,
  purpose: 'PDF 내용을 구조적으로 검사',
  candidate: {
    manager: 'uv-tool' as const,
    registry: 'pypi' as const,
    tool: { name: 'PyMuPDF', version: '1.26.3', entrypoints: ['pymupdf'] },
  },
  access: { credentials: 'none' as const, externalNetworkAtRuntime: false, paidService: false },
};

describe('Workbench AI tool acquisition policy', () => {
  it('keeps safe-looking exact local packages approval-gated until supply-chain isolation exists', () => {
    const decision = classifyWorkbenchToolAcquisition(base);
    expect(decision).toMatchObject({
      disposition: 'approval_required', authority: 'user_or_operator', risk: 'high',
      normalizedTool: { name: 'pymupdf', version: '1.26.3', entrypoints: ['pymupdf'] },
      supplyChain: {
        exactVersionPinned: true, credentialsSuppressedDuringInstall: true,
        packageHooksIsolated: false, provenanceVerified: false,
      },
    });
    expect(decision.userFacingSummary).not.toContain('uv tool install');
    expect(decision.userFacingSummary).not.toContain('revision');
  });

  it.each([
    [{ credentials: 'required' as const, externalNetworkAtRuntime: false, paidService: false }, 'credential'],
    [{ credentials: 'none' as const, externalNetworkAtRuntime: true, paidService: false }, 'network'],
    [{ credentials: 'none' as const, externalNetworkAtRuntime: false, paidService: true }, 'paid'],
  ])('refuses acquisition that bundles separate authority (%s)', (access, reason) => {
    const decision = classifyWorkbenchToolAcquisition({ ...base, access });
    expect(decision).toMatchObject({ disposition: 'refused', authority: 'operator_only', risk: 'prohibited' });
    expect(decision.reasons.join(' ').toLowerCase()).toContain(reason);
  });

  it('rejects unpinned or unsafe package identity through the existing Workbench spec boundary', () => {
    expect(() => classifyWorkbenchToolAcquisition({
      ...base,
      candidate: { ...base.candidate, tool: { name: 'safe;curl evil', version: 'latest', entrypoints: ['safe'] } },
    })).toThrow('unsafe tool name');
  });
});
