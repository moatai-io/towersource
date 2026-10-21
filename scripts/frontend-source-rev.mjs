import { execFileSync } from 'node:child_process';

const isRevision = (value) => /^[a-f0-9]{40}$/.test(value || '');

/** Resolve the immutable source being built, never an inherited runtime identity. */
export function resolveFrontendSourceRev({ env = process.env, readGit = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } = {}) {
  // Pre-push builds a plain Git archive, without .git. Its attested SHA takes
  // precedence over SOURCE_REV inherited from a running packaged backend.
  const snapshot = env.TOWER_SOURCE_SHA?.trim();
  if (isRevision(snapshot)) return snapshot;
  try {
    const git = readGit();
    if (isRevision(git)) return git;
  } catch {
    // Packaged/Nix source has no Git metadata; use the explicit build identity.
  }
  const injected = env.SOURCE_REV?.trim();
  return isRevision(injected) ? injected : '';
}
