// Temporal observations are review evidence only; never promote them to commit ownership.
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
export function readBashObservations(file, sessionId) {
  try {
    if (statSync(file).size > 32 * 1024 * 1024) return { status: 'limit-exceeded', candidates: [], conflicts: [] };
    const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const own = rows.filter(r => r.version === 1 && r.sessionId === sessionId);
    const valid = p => typeof p === 'string' && !isAbsolute(p) && !p.split(/[\\/]/).some(x => x === '..' || !x);
    const candidates = [...new Set(own.flatMap(r => Array.isArray(r.paths) ? r.paths.filter(valid) : []))].sort();
    const otherPaths = new Set(rows.filter(r => r.sessionId !== sessionId).flatMap(r => Array.isArray(r.paths) ? r.paths.filter(valid) : []));
    return { status: own.some(r => !r.complete) ? 'incomplete' : 'ok', candidates, conflicts: candidates.filter(p => otherPaths.has(p)) };
  } catch (error) { return { status: error.code === 'ENOENT' ? 'not-recorded' : 'unavailable', candidates: [], conflicts: [] }; }
}
