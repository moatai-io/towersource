// Narrow recorded candidates; never create ownership from a requested path.
export function selectSessionCandidates(summary, requested) {
  if (!requested.length) return summary;
  if (summary.repos.length !== 1) throw new Error('Explicit path selection requires one repository');
  const repo = summary.repos[0];
  const paths = [...new Set(requested)];
  const known = new Set(repo.candidates.map(f => f.rel));
  for (const p of paths) {
    if (!p || p.startsWith('/') || p.includes('\\') || p.split('/').some(x => !x || x === '.' || x === '..') || !known.has(p)) {
      throw new Error(`Selected path is not a current recorded candidate: ${p}`);
    }
  }
  const selected = new Set(paths);
  const excluded = repo.candidates.filter(f => !selected.has(f.rel));
  return { ...summary, selectedPaths: [...selected].sort(), repos: [{ ...repo,
    candidates: repo.candidates.filter(f => selected.has(f.rel)),
    untouchedDirty: [...repo.untouchedDirty, ...excluded].sort((a,b) => a.rel.localeCompare(b.rel)),
  }] };
}
