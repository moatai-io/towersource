// Advisory eligibility only; never authorizes dropping validation gates.
export function impactPolicy({ changes, selectedCount, discoveryError = false }) {
  const reasons = [];
  if (discoveryError) reasons.push('discovery-unavailable');
  for (const { status, path } of changes) {
    if (!['A', 'M'].includes(status)) reasons.push(`structural-change:${status}`);
    if (!/^packages\/(backend|frontend|shared)\/.*\.(ts|tsx)$/.test(path)) reasons.push('non-import-or-unknown-change');
    if (/\/db\/migrations\/|\/sandbox-images\/|\/scripts\/|(^|\/)(config|vite\.config|vitest\.config)\./.test(path)) reasons.push('configuration-or-runtime-boundary');
  }
  if (changes.length && selectedCount === 0) reasons.push('empty-selection');
  if (!changes.length) reasons.push('no-changes');
  return { mode: 'shadow-only', candidate: reasons.length === 0 ? 'impact-selection' : 'existing-validation', reasons: [...new Set(reasons)] };
}
