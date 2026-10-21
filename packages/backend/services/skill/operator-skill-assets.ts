import fs from 'node:fs';
import { prepareHostSkillSnapshot } from './host-skill-snapshot.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isSafeSkillName } from './teamskills-source.js';
import { scanSkillBundleForReadOnlyMount } from './skill-materialization-scanner.js';
import { computeBundleDigest } from './skill-bundle-resolver.js';
import { resolveTrustedTeamskillsSkillSource } from './managed-teamskills-source.js';

/** Internal resolver. Caller must first verify current Operator access and skill visibility.
 * Does not grant access, execute scripts, or expose source paths on a failed check.
 */
export function resolveOperatorSkillAssets(projectRoot: string | undefined, name: string, body: string) {
  const blocked = (reason: string) => ({ status: 'blocked' as const, reason });
  if (!projectRoot || !isSafeSkillName(name)) return blocked('invalid_context');
  try {
    const root = path.resolve(projectRoot);
    const manifestPath = path.join(root, '.tower/skills/manifest.json');
    if (fs.realpathSync(manifestPath) !== manifestPath) return blocked('unsafe_manifest_path');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (![2, 3].includes(manifest.schemaVersion) || !Array.isArray(manifest.skills)) return blocked('unsupported_manifest');
    const entries = manifest.skills.filter((entry: any) => entry.name === name);
    if (entries.length !== 1) return blocked('not_manifest_listed');
    const entry = entries[0];
    if (entry.sourceKind !== 'teamskills' || entry.canonicalId !== `tower://org/teamskills/${name}`) return blocked('unsupported_source');
    const source = resolveTrustedTeamskillsSkillSource(name);
    if (!source) return blocked('unsafe_source_path');
    const scan = scanSkillBundleForReadOnlyMount(source);
    if (!scan.ok || scan.findings.some(f => f.code.startsWith('symlink'))) return blocked('unsafe_bundle');
    const files = scan.filesAllowed.map(relativePath => {
      const bytes = fs.readFileSync(path.join(source, relativePath));
      return { relativePath, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    if (computeBundleDigest(files) !== entry.bundleDigest) return blocked('bundle_digest_mismatch');
    if (fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8') !== body) return blocked('body_source_mismatch');
    const executionDirectory = prepareHostSkillSnapshot(root, name, entry.bundleDigest, source, files.map(f => f.relativePath));
    return {
      executionDirectory,
      managedRuntimePath: executionDirectory,
      bodyOnly: false,
      status: 'source-verified' as const,
      sourceDirectory: source,
      bundleDigest: entry.bundleDigest as string,
      files: files.map(f => f.relativePath),
      guidance: 'Use executionDirectory for scripts and references on the assigned host Workstation. Replace the /workspace/.tower/skills/<name> prefix in skill examples with this verified Project-local snapshot path; do not execute organization source paths. Gateway declarations remain bound to the current Project manifest. Keep this snapshot unchanged, set PYTHONDONTWRITEBYTECODE=1, and write outputs/cache outside it. This verifies file availability, not provider authentication or execution success.',
    };
  } catch {
    return blocked('source_or_manifest_unavailable');
  }
}
