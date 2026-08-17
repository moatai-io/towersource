/**
 * Owns: Best-effort official registry release evidence for Workbench tool revisions.
 * Public API: collectPyPiReleaseEvidence, assertValidRegistryReleaseEvidence.
 *
 * This is not proof of the exact artifact selected by uv. It records the official
 * release file set visible from PyPI at acquisition time.
 */

import type { WorkbenchToolSpec } from './workbench-tools.js';

export interface WorkbenchRegistryArtifactEvidence {
  filename: string;
  packageType: string;
  sha256: string;
  size: number;
  url: string;
}

export interface WorkbenchRegistryReleaseEvidence {
  status: 'verified' | 'unavailable';
  registry: 'pypi';
  package: string;
  version: string;
  metadataUrl: string;
  checkedAt: string;
  artifacts: WorkbenchRegistryArtifactEvidence[];
  limitation: 'registry-release-file-set-not-selected-artifact';
  error?: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PYPI_FILE_URL_PATTERN = /^https:\/\/files\.pythonhosted\.org\//;

/** Validate evidence before it becomes part of an immutable manifest. */
export function assertValidRegistryReleaseEvidence(input: WorkbenchRegistryReleaseEvidence, tool: WorkbenchToolSpec): void {
  if (input.registry !== 'pypi' || input.package.toLowerCase() !== tool.name.toLowerCase() || input.version !== tool.version) {
    throw new Error(`Registry evidence identity mismatch for ${tool.name}`);
  }
  if (input.metadataUrl !== `https://pypi.org/pypi/${encodeURIComponent(tool.name)}/${encodeURIComponent(tool.version)}/json`) {
    throw new Error(`Registry evidence metadata URL mismatch for ${tool.name}`);
  }
  if (input.limitation !== 'registry-release-file-set-not-selected-artifact' || !Number.isFinite(Date.parse(input.checkedAt))) {
    throw new Error(`Registry evidence metadata invalid for ${tool.name}`);
  }
  if (input.status === 'unavailable') {
    if (input.artifacts.length !== 0 || !input.error?.trim()) throw new Error(`Unavailable registry evidence is incomplete for ${tool.name}`);
    return;
  }
  if (!input.artifacts.length) throw new Error(`Verified registry evidence has no artifacts for ${tool.name}`);
  const filenames = new Set<string>();
  for (const artifact of input.artifacts) {
    if (!artifact.filename || filenames.has(artifact.filename) || !SHA256_PATTERN.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.size) || artifact.size < 0 || !PYPI_FILE_URL_PATTERN.test(artifact.url)) {
      throw new Error(`Registry artifact evidence invalid for ${tool.name}`);
    }
    filenames.add(artifact.filename);
  }
}

/** Fetch official PyPI release metadata without credentials; failure is explicit evidence, not install failure. */
export async function collectPyPiReleaseEvidence(
  tool: WorkbenchToolSpec,
  options: { fetch?: typeof fetch; checkedAt?: string } = {},
): Promise<WorkbenchRegistryReleaseEvidence> {
  const metadataUrl = `https://pypi.org/pypi/${encodeURIComponent(tool.name)}/${encodeURIComponent(tool.version)}/json`;
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const unavailable = (error: string): WorkbenchRegistryReleaseEvidence => ({
    status: 'unavailable', registry: 'pypi', package: tool.name, version: tool.version,
    metadataUrl, checkedAt, artifacts: [], limitation: 'registry-release-file-set-not-selected-artifact', error,
  });
  try {
    const response = await (options.fetch ?? fetch)(metadataUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return unavailable(`PyPI metadata request failed with HTTP ${response.status}`);
    const payload = await response.json() as { info?: { name?: string; version?: string }; urls?: Array<any> };
    if (payload.info?.name?.toLowerCase() !== tool.name.toLowerCase() || payload.info?.version !== tool.version || !Array.isArray(payload.urls)) {
      return unavailable('PyPI metadata identity or file list did not match the requested release');
    }
    const artifacts = payload.urls.map(item => ({
      filename: String(item.filename ?? ''), packageType: String(item.packagetype ?? ''),
      sha256: String(item.digests?.sha256 ?? '').toLowerCase(), size: Number(item.size), url: String(item.url ?? ''),
    })).sort((a, b) => a.filename.localeCompare(b.filename));
    const evidence: WorkbenchRegistryReleaseEvidence = {
      status: 'verified', registry: 'pypi', package: tool.name, version: tool.version,
      metadataUrl, checkedAt, artifacts, limitation: 'registry-release-file-set-not-selected-artifact',
    };
    assertValidRegistryReleaseEvidence(evidence, tool);
    return evidence;
  } catch (error) {
    return unavailable((error as Error).message || 'PyPI metadata request failed');
  }
}
