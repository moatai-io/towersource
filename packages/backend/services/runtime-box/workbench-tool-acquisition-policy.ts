/**
 * Owns: Supply-chain and authority classification for AI-selected Workbench tools.
 * Public API: classifyWorkbenchToolAcquisition.
 *
 * This module decides who may authorize acquisition. It does not install tools.
 */

import { assertSafeToolSpec, type WorkbenchToolSpec } from './workbench-tools.js';

export type WorkbenchToolCapability =
  | 'document-processing'
  | 'data-analysis'
  | 'media-processing'
  | 'code-quality'
  | 'network-diagnostics'
  | 'general-utility';

export interface WorkbenchToolAcquisitionRequest {
  capability: WorkbenchToolCapability;
  purpose: string;
  candidate: {
    manager: 'uv-tool';
    registry: 'pypi';
    tool: WorkbenchToolSpec;
  };
  access: {
    credentials: 'none' | 'required';
    externalNetworkAtRuntime: boolean;
    paidService: boolean;
  };
}

export interface WorkbenchToolAcquisitionDecision {
  disposition: 'ai_managed' | 'approval_required' | 'refused';
  authority: 'tower_policy' | 'user_or_operator' | 'operator_only';
  risk: 'low' | 'high' | 'prohibited';
  reasons: string[];
  userFacingSummary: string;
  normalizedTool: WorkbenchToolSpec;
  supplyChain: {
    manager: 'uv-tool';
    registry: 'pypi';
    exactVersionPinned: true;
    credentialsSuppressedDuringInstall: true;
    packageHooksIsolated: false;
    provenanceVerified: false;
  };
}

/**
 * Classify an AI-selected exact package without exposing package mechanics as user UX.
 * Until hooks and provenance are isolated, every install remains operator-approved internal dogfood.
 */
export function classifyWorkbenchToolAcquisition(input: WorkbenchToolAcquisitionRequest): WorkbenchToolAcquisitionDecision {
  if (!input.purpose.trim()) throw new Error('Workbench tool acquisition purpose is required');
  assertSafeToolSpec(input.candidate.tool);
  const normalizedTool = {
    ...input.candidate.tool,
    name: input.candidate.tool.name.toLowerCase(),
    entrypoints: [...new Set(input.candidate.tool.entrypoints)],
  };
  const prohibited: string[] = [];
  if (input.access.credentials === 'required') prohibited.push('The tool requires credential access; Workbench installation is credential-free and cannot grant runtime authority.');
  if (input.access.paidService) prohibited.push('The tool depends on a paid service; cost authority must be established outside tool acquisition.');
  if (input.access.externalNetworkAtRuntime) prohibited.push('The requested capability needs runtime network access, which is separate from installing a local CLI.');
  if (prohibited.length) {
    return {
      disposition: 'refused', authority: 'operator_only', risk: 'prohibited', reasons: prohibited,
      userFacingSummary: '이 작업은 단순 로컬 도구 설치 범위를 넘어 별도 권한 검토가 필요합니다.', normalizedTool,
      supplyChain: {
        manager: 'uv-tool', registry: 'pypi', exactVersionPinned: true, credentialsSuppressedDuringInstall: true,
        packageHooksIsolated: false, provenanceVerified: false,
      },
    };
  }
  return {
    disposition: 'approval_required', authority: 'user_or_operator', risk: 'high',
    reasons: [
      'The AI selected an exact PyPI package and entrypoints for a stated capability.',
      'Installation runs without Vault credentials and cannot persist writes to the Project source.',
      'Package hooks are not isolated and registry provenance is not yet verified, so autonomous acquisition is not enabled.',
    ],
    userFacingSummary: `AI가 “${input.purpose.trim()}” 작업에 필요한 로컬 도구를 준비하려 합니다. 현재 내부 베타에서는 공급망 검토 승인이 필요합니다.`,
    normalizedTool,
    supplyChain: {
      manager: 'uv-tool', registry: 'pypi', exactVersionPinned: true, credentialsSuppressedDuringInstall: true,
      packageHooksIsolated: false, provenanceVerified: false,
    },
  };
}
