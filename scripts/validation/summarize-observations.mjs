import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function summarize(text) {
  const groups = new Map(); let invalid = 0;
  for (const line of text.split('\n').filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { invalid++; continue; }
    if (!event.runId || !event.planHash || !event.checkId || !Number.isFinite(event.durationMs) || event.durationMs < 0 || !['passed', 'failed', 'execution-error'].includes(event.status)) { invalid++; continue; }
    const key = JSON.stringify([event.planHash, event.checkId]);
    if (!groups.has(key)) groups.set(key, { planHash: event.planHash, checkId: event.checkId, sourceRevision: event.sourceRevision, workingTree: event.workingTree, records: new Map() });
    groups.get(key).records.set(event.runId, event);
  }
  return { invalidRecords: invalid, groups: [...groups.values()].map(({ records, ...meta }) => {
    const events = [...records.values()]; const durations = events.map(e => e.durationMs).sort((a,b) => a-b);
    const percentile = p => durations[Math.max(0, Math.ceil(durations.length*p)-1)];
    return { ...meta, runs: events.length, passed: events.filter(e => e.status === 'passed').length, failed: events.filter(e => e.status === 'failed').length, executionErrors: events.filter(e => e.status === 'execution-error').length, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: durations.at(-1) };
  }) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw Error('usage: summarize-observations.mjs <jsonl>');
  console.log(JSON.stringify(summarize(readFileSync(process.argv[2], 'utf8')), null, 2));
}
