import { describe, expect, it, vi } from 'vitest';
import { assertValidRegistryReleaseEvidence, collectPyPiReleaseEvidence } from './workbench-tool-registry-evidence.js';

const tool = { name: 'ruff', version: '0.12.0', entrypoints: ['ruff'] };
const checkedAt = '2026-08-04T00:00:00.000Z';

describe('Workbench PyPI registry release evidence', () => {
  it('records a deterministic official release file set with SHA-256 values', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      info: { name: 'ruff', version: '0.12.0' },
      urls: [
        { filename: 'ruff-0.12.0.tar.gz', packagetype: 'sdist', size: 12, url: 'https://files.pythonhosted.org/packages/a/source.tar.gz', digests: { sha256: 'b'.repeat(64) } },
        { filename: 'ruff-0.12.0-py3-none-any.whl', packagetype: 'bdist_wheel', size: 10, url: 'https://files.pythonhosted.org/packages/a/wheel.whl', digests: { sha256: 'a'.repeat(64) } },
      ],
    }), { status: 200 }));
    const evidence = await collectPyPiReleaseEvidence(tool, { fetch: fetchMock, checkedAt });
    expect(evidence).toMatchObject({
      status: 'verified', registry: 'pypi', package: 'ruff', version: '0.12.0', checkedAt,
      limitation: 'registry-release-file-set-not-selected-artifact',
    });
    expect(evidence.artifacts.map(item => item.filename)).toEqual(['ruff-0.12.0-py3-none-any.whl', 'ruff-0.12.0.tar.gz']);
    expect(() => assertValidRegistryReleaseEvidence(evidence, tool)).not.toThrow();
  });

  it('records unavailable evidence instead of breaking installation when metadata cannot be fetched', async () => {
    const evidence = await collectPyPiReleaseEvidence(tool, {
      fetch: vi.fn().mockResolvedValue(new Response('', { status: 503 })), checkedAt,
    });
    expect(evidence).toMatchObject({ status: 'unavailable', artifacts: [], error: 'PyPI metadata request failed with HTTP 503' });
    expect(() => assertValidRegistryReleaseEvidence(evidence, tool)).not.toThrow();
  });

  it('rejects identity, digest, duplicate filename, and non-official file URL drift', () => {
    const base = {
      status: 'verified' as const, registry: 'pypi' as const, package: 'ruff', version: '0.12.0',
      metadataUrl: 'https://pypi.org/pypi/ruff/0.12.0/json', checkedAt,
      limitation: 'registry-release-file-set-not-selected-artifact' as const,
      artifacts: [{ filename: 'ruff.whl', packageType: 'bdist_wheel', sha256: 'a'.repeat(64), size: 10, url: 'https://files.pythonhosted.org/packages/a/ruff.whl' }],
    };
    expect(() => assertValidRegistryReleaseEvidence({ ...base, package: 'other' }, tool)).toThrow('identity');
    expect(() => assertValidRegistryReleaseEvidence({ ...base, artifacts: [{ ...base.artifacts[0], sha256: 'bad' }] }, tool)).toThrow('artifact');
    expect(() => assertValidRegistryReleaseEvidence({ ...base, artifacts: [base.artifacts[0], base.artifacts[0]] }, tool)).toThrow('artifact');
    expect(() => assertValidRegistryReleaseEvidence({ ...base, artifacts: [{ ...base.artifacts[0], url: 'https://evil.example/ruff.whl' }] }, tool)).toThrow('artifact');
  });
});
