/**
 * Owns: AI-facing capability projection for installed Workbench tools.
 * Public API: projectWorkbenchToolInventory, findMissingWorkbenchCapabilities.
 *
 * Installation manifests remain authoritative. This file is only a read model.
 */

import type { WorkbenchToolInspection, WorkbenchToolManifest, WorkbenchToolSpec } from './workbench-tools.js';
import type { WorkbenchToolCapability } from './workbench-tool-acquisition-policy.js';

export interface WorkbenchToolCapabilityDescriptor {
  id: string;
  family: WorkbenchToolCapability;
  description: string;
  confidence: 'catalog' | 'entrypoint-only';
}

export interface WorkbenchToolInventoryItem {
  name: string;
  version: string;
  entrypoints: string[];
  capabilities: WorkbenchToolCapabilityDescriptor[];
}

export interface WorkbenchToolInventory {
  status: 'ready' | 'empty' | 'unavailable';
  activeRevision: number | null;
  health: WorkbenchToolInspection['health'];
  usableByCurrentRuntime: boolean;
  runtimeRecreateRequired: boolean | null;
  tools: WorkbenchToolInventoryItem[];
  capabilityIds: string[];
  guidance: string;
}

const CATALOG: Record<string, WorkbenchToolCapabilityDescriptor[]> = {
  ruff: [
    { id: 'python-lint', family: 'code-quality', description: 'Python source linting', confidence: 'catalog' },
    { id: 'python-format', family: 'code-quality', description: 'Python source formatting', confidence: 'catalog' },
  ],
  pymupdf: [
    { id: 'pdf-inspect', family: 'document-processing', description: 'Inspect PDF structure and metadata', confidence: 'catalog' },
    { id: 'pdf-extract-text', family: 'document-processing', description: 'Extract text from PDF documents', confidence: 'catalog' },
  ],
  csvkit: [
    { id: 'csv-inspect', family: 'data-analysis', description: 'Inspect and summarize CSV data', confidence: 'catalog' },
    { id: 'csv-transform', family: 'data-analysis', description: 'Transform tabular CSV data', confidence: 'catalog' },
  ],
  cowsay: [
    { id: 'terminal-text-render', family: 'general-utility', description: 'Render decorative terminal text', confidence: 'catalog' },
  ],
  pyfiglet: [
    { id: 'terminal-banner-render', family: 'general-utility', description: 'Render terminal banner text', confidence: 'catalog' },
  ],
};

function projectTool(tool: WorkbenchToolSpec): WorkbenchToolInventoryItem {
  const key = tool.name.toLowerCase();
  const capabilities = CATALOG[key] ?? tool.entrypoints.map(entrypoint => ({
    id: `execute:${entrypoint}`,
    family: 'general-utility' as const,
    description: `Execute installed entrypoint ${entrypoint}; semantic capability is not cataloged`,
    confidence: 'entrypoint-only' as const,
  }));
  return { name: tool.name, version: tool.version, entrypoints: [...tool.entrypoints], capabilities };
}

/** Project the authoritative active manifest into a compact AI decision surface. */
export function projectWorkbenchToolInventory(input: {
  inspection: WorkbenchToolInspection;
  activeManifest: WorkbenchToolManifest | null;
}): WorkbenchToolInventory {
  const { inspection, activeManifest } = input;
  if (inspection.health === 'recovery_required') {
    return {
      status: 'unavailable', activeRevision: inspection.dbRevision, health: inspection.health,
      usableByCurrentRuntime: false, runtimeRecreateRequired: inspection.recreateRequired,
      tools: [], capabilityIds: [], guidance: 'Workbench tool state requires operator recovery; do not acquire or use tools.',
    };
  }
  if (inspection.dbRevision == null || !activeManifest) {
    return {
      status: 'empty', activeRevision: null, health: inspection.health,
      usableByCurrentRuntime: true, runtimeRecreateRequired: false,
      tools: [], capabilityIds: [], guidance: 'No managed tools are installed. Acquire a tool only when the current task needs a missing capability.',
    };
  }
  if (activeManifest.revision !== inspection.dbRevision) {
    return {
      status: 'unavailable', activeRevision: inspection.dbRevision, health: 'recovery_required',
      usableByCurrentRuntime: false, runtimeRecreateRequired: inspection.recreateRequired,
      tools: [], capabilityIds: [], guidance: 'Active revision metadata and inventory manifest disagree; do not infer tool availability.',
    };
  }
  const tools = activeManifest.tools.map(({ name, version, entrypoints }) => projectTool({ name, version, entrypoints }));
  const capabilityIds = [...new Set(tools.flatMap(tool => tool.capabilities.map(capability => capability.id)))].sort();
  const recreateRequired = inspection.recreateRequired === true;
  return {
    status: 'ready', activeRevision: inspection.dbRevision, health: inspection.health,
    usableByCurrentRuntime: !recreateRequired, runtimeRecreateRequired: inspection.recreateRequired,
    tools, capabilityIds,
    guidance: recreateRequired
      ? 'The active tool revision is finalized but the running Runtime is older. Do not assume new capabilities are usable until separately approved Runtime recreate.'
      : 'Reuse installed capabilities before proposing acquisition. Entrypoint-only capabilities require task-specific verification.',
  };
}

/** Return requested capability ids absent from a healthy, currently usable inventory. */
export function findMissingWorkbenchCapabilities(inventory: WorkbenchToolInventory, requested: string[]): string[] {
  if (inventory.status !== 'ready' || !inventory.usableByCurrentRuntime) return [...new Set(requested)].sort();
  const available = new Set(inventory.capabilityIds);
  return [...new Set(requested)].filter(item => !available.has(item)).sort();
}
