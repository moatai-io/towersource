#!/usr/bin/env node
/**
 * Pi run observability report from Tower/PM2 logs.
 *
 * Phase 3 starts with structured log parsing instead of a DB table: pi-engine.ts
 * emits one [PiRunSummary] per turn boundary, and this script summarizes recent
 * real production behavior (transient suppressions, forced terminalization,
 * context runway, tool-loop duration).
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_LOG = path.join(process.env.HOME || '/home/tower', '.pm2/logs/tower-prod-out.log');

function stripAnsi(s) {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function parseArgs(argv) {
  const args = {
    file: DEFAULT_LOG,
    sinceHours: 24,
    json: false,
    limit: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--file' && argv[i + 1]) args.file = argv[++i];
    else if (a === '--since-hours' && argv[i + 1]) args.sinceHours = Number(argv[++i]);
    else if (a === '--limit' && argv[i + 1]) args.limit = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '-h' || a === '--help') {
      console.log(`Usage: node scripts/pi-run-summary-report.mjs [--file PATH] [--since-hours N] [--limit N] [--json]\n\nDefault file: ${DEFAULT_LOG}`);
      process.exit(0);
    }
  }
  return args;
}

function parseTimestamp(line) {
  // PM2 out log usually prefixes: 2026-06-01 00:24:35: [PiRunSummary] ...
  const m = line.match(/(20\d\d-\d\d-\d\d) (\d\d:\d\d:\d\d):/);
  if (!m) return undefined;
  const d = new Date(`${m[1]}T${m[2]}+09:00`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function parseBool(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function parsePiRunSummaryLine(rawLine) {
  const line = stripAnsi(rawLine);
  const idx = line.indexOf('[PiRunSummary]');
  if (idx < 0) return undefined;
  const timestamp = parseTimestamp(line);
  const rest = line.slice(idx + '[PiRunSummary]'.length).trim();
  const pairs = [...rest.matchAll(/(\w+)=([^\s]+)/g)];
  const row = { timestamp: timestamp?.toISOString(), raw: line };
  for (const [, key, value] of pairs) row[key] = value;
  row.iterations = Number(row.iterations || 0);
  row.tools = Number(row.tools || 0);
  row.durationMs = Number(row.durationMs || 0);
  row.terminalForced = parseBool(row.terminalForced) ?? false;
  row.suppressed = parseBool(row.suppressed) ?? false;
  if (typeof row.ctx === 'string') {
    const [used, window] = row.ctx.split('/').map(Number);
    row.contextUsed = Number.isFinite(used) ? used : undefined;
    row.contextWindow = Number.isFinite(window) ? window : undefined;
    row.contextPct = row.contextUsed && row.contextWindow ? row.contextUsed / row.contextWindow : undefined;
  }
  return row;
}

function parsePiOperationalEvent(rawLine) {
  const line = stripAnsi(rawLine);
  const timestamp = parseTimestamp(line)?.toISOString();
  if (line.includes('transient transport error suppressed')) return { timestamp, type: 'transient_suppressed', raw: line };
  if (line.includes('closing terminalizer firing')) return { timestamp, type: 'closing_terminalizer', raw: line };
  if (line.includes('force terminalizing run')) return { timestamp, type: 'force_terminalize', raw: line };
  // Do not count normal run-start configuration logs like
  // "watchdog=idle3600s/block7200s". Only count watchdog intervention signals.
  if (line.includes('[Pi]') && /watchdog (abort|firing|stuck|timeout)|watchdog=\{/.test(line)) {
    return { timestamp, type: 'watchdog', raw: line };
  }
  return undefined;
}

function countBy(items, keyFn) {
  const out = new Map();
  for (const item of items) {
    const key = keyFn(item) || '(none)';
    out.set(key, (out.get(key) || 0) + 1);
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

function percentile(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[idx];
}

function countValue(counts, key) {
  return counts.find(([k]) => k === key)?.[1] || 0;
}

function buildSessionRollups(rows) {
  const bySession = new Map();
  for (const row of rows) {
    const key = row.session || '(unknown)';
    const entry = bySession.get(key) || {
      session: key,
      turns: 0,
      complete: 0,
      aborted: 0,
      error: 0,
      failures: {},
      suppressed: 0,
      terminalForced: 0,
      tools: 0,
      iterations: 0,
      maxContextPct: 0,
      maxDurationMs: 0,
      lastAt: undefined,
      models: new Set(),
    };
    entry.turns += 1;
    if (row.final === 'complete') entry.complete += 1;
    else if (row.final === 'aborted') entry.aborted += 1;
    else if (row.final === 'error') entry.error += 1;
    if (row.failure) entry.failures[row.failure] = (entry.failures[row.failure] || 0) + 1;
    if (row.suppressed) entry.suppressed += 1;
    if (row.terminalForced) entry.terminalForced += 1;
    entry.tools += row.tools || 0;
    entry.iterations += row.iterations || 0;
    entry.maxContextPct = Math.max(entry.maxContextPct, row.contextPct || 0);
    entry.maxDurationMs = Math.max(entry.maxDurationMs, row.durationMs || 0);
    entry.lastAt = row.timestamp || entry.lastAt;
    if (row.model) entry.models.add(row.model);
    bySession.set(key, entry);
  }
  return [...bySession.values()]
    .map((entry) => ({
      ...entry,
      models: [...entry.models].sort(),
      failureSummary: Object.entries(entry.failures).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    }))
    .sort((a, b) => (
      b.error - a.error
      || b.terminalForced - a.terminalForced
      || b.suppressed - a.suppressed
      || b.maxContextPct - a.maxContextPct
      || b.turns - a.turns
      || a.session.localeCompare(b.session)
    ));
}

function buildAnomalies(rows, events) {
  const anomalies = [];
  for (const row of rows) {
    if (row.final === 'error' || row.failure === 'unknown_fatal') anomalies.push({ severity: 'critical', type: 'fatal', row });
    if (row.failure === 'watchdog_stuck') anomalies.push({ severity: 'critical', type: 'watchdog_stuck', row });
    if (row.terminalForced) anomalies.push({ severity: row.failure === 'transient_transport' ? 'watch' : 'degraded', type: 'terminal_forced', row });
    if ((row.contextPct || 0) >= 0.9) anomalies.push({ severity: 'degraded', type: 'context_90', row });
    else if ((row.contextPct || 0) >= 0.8) anomalies.push({ severity: 'watch', type: 'context_80', row });
    if ((row.durationMs || 0) >= 10 * 60_000) anomalies.push({ severity: 'watch', type: 'slow_10m', row });
    if ((row.tools || 0) >= 25 || (row.iterations || 0) >= 25) anomalies.push({ severity: 'watch', type: 'heavy_tool_loop', row });
  }
  for (const event of events) {
    if (event.type === 'watchdog' || event.type === 'closing_terminalizer') anomalies.push({ severity: 'degraded', type: event.type, event });
    if (event.type === 'force_terminalize') anomalies.push({ severity: 'watch', type: event.type, event });
  }
  return anomalies.sort((a, b) => {
    const rank = { critical: 3, degraded: 2, watch: 1, ok: 0 };
    return (rank[b.severity] || 0) - (rank[a.severity] || 0);
  });
}

function buildHealth(summaryLike) {
  const { total, finalCounts, failureCounts, eventCounts, suppressed, terminalForced, context, duration } = summaryLike;
  const fatal = countValue(failureCounts, 'unknown_fatal') + countValue(finalCounts, 'error');
  const watchdog = countValue(failureCounts, 'watchdog_stuck') + countValue(eventCounts, 'watchdog');
  const closingTerminalizer = countValue(eventCounts, 'closing_terminalizer');
  const transient = countValue(failureCounts, 'transient_transport');
  const reasons = [];
  const actions = [];
  let verdict = 'ok';

  if (!total) {
    return {
      verdict: 'ok',
      reasons: ['No PiRunSummary rows in the selected window.'],
      actions: ['If this is unexpected, verify PM2 log path and whether Pi traffic occurred in the window.'],
    };
  }

  if (fatal > 0 || watchdog > 0) {
    verdict = 'critical';
    if (fatal > 0) reasons.push(`fatal/error turns detected: ${fatal}`);
    if (watchdog > 0) reasons.push(`watchdog intervention detected: ${watchdog}`);
    actions.push('Inspect the raw session logs for fatal/watchdog rows before tuning retry or timeout policy.');
  } else if (closingTerminalizer > 0 || terminalForced >= Math.max(3, Math.ceil(total * 0.15)) || context.maxPct >= 0.9) {
    verdict = 'degraded';
    if (closingTerminalizer > 0) reasons.push(`closing terminalizer events: ${closingTerminalizer}`);
    if (terminalForced >= Math.max(3, Math.ceil(total * 0.15))) reasons.push(`terminalForced rate is high: ${terminalForced}/${total}`);
    if (context.maxPct >= 0.9) reasons.push(`context usage reached ${pct(context.maxPct)}`);
    actions.push('Review terminalForced sessions and context runway; consider provider/router stability or compaction tuning if this persists.');
  } else if (transient > 0 || suppressed > 0 || context.maxPct >= 0.8 || duration.maxMs >= 10 * 60_000) {
    verdict = 'watch';
    if (transient > 0 || suppressed > 0) reasons.push(`transient transport was suppressed: ${Math.max(transient, suppressed)} turn(s)`);
    if (context.maxPct >= 0.8) reasons.push(`context usage is nearing runway: ${pct(context.maxPct)}`);
    if (duration.maxMs >= 10 * 60_000) reasons.push(`long-running tool turn observed: ${ms(duration.maxMs)}`);
    actions.push('Continue observing real sessions; no whole-prompt retry is recommended for suppressed transient drops after tool work.');
  } else {
    reasons.push('No fatal, watchdog, high-context, or forced-terminalization signals in this window.');
    actions.push('No action needed beyond routine observation.');
  }

  if (!actions.some((a) => a.includes('Phase 4')) && (transient > 0 || terminalForced > 0)) {
    actions.push('Feed repeated user-visible confusion into Phase 4 status UX work: tool_running/stalled/closing copy.');
  }

  return { verdict, reasons, actions };
}

function summarize(rows, events) {
  const durations = rows.map((r) => r.durationMs);
  const ctxPcts = rows.map((r) => r.contextPct).filter(Number.isFinite);
  const finalCounts = countBy(rows, (r) => r.final);
  const failureCounts = countBy(rows.filter((r) => r.failure), (r) => r.failure);
  const modelCounts = countBy(rows, (r) => r.model);
  const eventCounts = countBy(events, (e) => e.type);
  const suppressedRows = rows.filter((r) => r.suppressed);
  const terminalForcedRows = rows.filter((r) => r.terminalForced);
  const nearContextRows = rows.filter((r) => (r.contextPct || 0) >= 0.8)
    .sort((a, b) => (b.contextPct || 0) - (a.contextPct || 0));
  const slowRows = [...rows].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
  const toolLoopRows = rows.filter((r) => r.tools >= 10 || r.iterations >= 10)
    .sort((a, b) => (b.tools + b.iterations) - (a.tools + a.iterations))
    .slice(0, 10);

  const base = {
    total: rows.length,
    firstAt: rows[0]?.timestamp,
    lastAt: rows[rows.length - 1]?.timestamp,
    finalCounts,
    failureCounts,
    modelCounts,
    eventCounts,
    suppressed: suppressedRows.length,
    terminalForced: terminalForcedRows.length,
    duration: {
      p50Ms: percentile(durations, 50),
      p90Ms: percentile(durations, 90),
      maxMs: percentile(durations, 100),
    },
    context: {
      maxPct: ctxPcts.length ? Math.max(...ctxPcts) : 0,
      near80Count: nearContextRows.length,
    },
    topSlow: slowRows,
    topToolLoops: toolLoopRows,
    nearContext: nearContextRows.slice(0, 10),
    suppressedRows: suppressedRows.slice(-10),
    terminalForcedRows: terminalForcedRows.slice(-10),
  };
  const sessionRollups = buildSessionRollups(rows).slice(0, 12);
  const anomalies = buildAnomalies(rows, events).slice(0, 20);
  return {
    ...base,
    health: buildHealth(base),
    sessionRollups,
    anomalies,
  };
}

function ms(msValue) {
  if (!Number.isFinite(msValue)) return '0s';
  if (msValue < 60_000) return `${(msValue / 1000).toFixed(1)}s`;
  return `${(msValue / 60_000).toFixed(1)}m`;
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function tableRows(rows, mapper) {
  if (!rows.length) return '  (none)';
  return rows.map(mapper).join('\n');
}

function formatAnomaly(anomaly) {
  const r = anomaly.row;
  if (r) {
    return `- ${anomaly.severity} ${anomaly.type}: ${r.timestamp || '?'} session=${r.session} final=${r.final}${r.failure ? ` failure=${r.failure}` : ''} tools=${r.tools} iterations=${r.iterations} ctx=${r.ctx || '?'} duration=${ms(r.durationMs)}`;
  }
  return `- ${anomaly.severity} ${anomaly.type}: ${anomaly.event?.timestamp || '?'} ${anomaly.event?.raw || ''}`;
}

function formatMarkdown(summary, opts) {
  return [
    `# Pi Run Summary Report`,
    ``,
    `- source: \`${opts.file}\``,
    `- window: last ${opts.sinceHours}h`,
    `- turns: ${summary.total}`,
    `- range: ${summary.firstAt || '(none)'} → ${summary.lastAt || '(none)'}`,
    ``,
    `## Health Verdict`,
    `- verdict: ${summary.health.verdict}`,
    tableRows(summary.health.reasons, (reason) => `- reason: ${reason}`),
    tableRows(summary.health.actions, (action) => `- action: ${action}`),
    ``,
    `## Outcomes`,
    tableRows(summary.finalCounts, ([k, v]) => `- ${k}: ${v}`),
    ``,
    `## Failures`,
    tableRows(summary.failureCounts, ([k, v]) => `- ${k}: ${v}`),
    ``,
    `## Models`,
    tableRows(summary.modelCounts, ([k, v]) => `- ${k}: ${v}`),
    ``,
    `## Operational Events`,
    tableRows(summary.eventCounts, ([k, v]) => `- ${k}: ${v}`),
    ``,
    `## Health Signals`,
    `- suppressed transient turns: ${summary.suppressed}`,
    `- terminalForced turns: ${summary.terminalForced}`,
    `- duration p50/p90/max: ${ms(summary.duration.p50Ms)} / ${ms(summary.duration.p90Ms)} / ${ms(summary.duration.maxMs)}`,
    `- max context usage: ${pct(summary.context.maxPct)}`,
    `- turns above 80% context: ${summary.context.near80Count}`,
    ``,
    `## Slowest Turns`,
    tableRows(summary.topSlow, (r) => `- ${r.timestamp || '?'} session=${r.session} final=${r.final}${r.failure ? ` failure=${r.failure}` : ''} tools=${r.tools} iterations=${r.iterations} ctx=${r.ctx || '?'} duration=${ms(r.durationMs)}`),
    ``,
    `## Tool-loop Heavy Turns`,
    tableRows(summary.topToolLoops, (r) => `- ${r.timestamp || '?'} session=${r.session} final=${r.final}${r.failure ? ` failure=${r.failure}` : ''} tools=${r.tools} iterations=${r.iterations} duration=${ms(r.durationMs)}`),
    ``,
    `## Near Context Limit`,
    tableRows(summary.nearContext, (r) => `- ${r.timestamp || '?'} session=${r.session} ctx=${r.ctx} (${pct(r.contextPct || 0)}) final=${r.final}${r.failure ? ` failure=${r.failure}` : ''}`),
    ``,
    `## Session Rollup`,
    tableRows(summary.sessionRollups, (s) => `- session=${s.session} turns=${s.turns} complete=${s.complete} aborted=${s.aborted} error=${s.error} suppressed=${s.suppressed} terminalForced=${s.terminalForced} maxCtx=${pct(s.maxContextPct)} maxDuration=${ms(s.maxDurationMs)} tools=${s.tools} iterations=${s.iterations}${s.failureSummary.length ? ` failures=${s.failureSummary.map(([k, v]) => `${k}:${v}`).join(',')}` : ''}`),
    ``,
    `## Recent Anomalies`,
    tableRows(summary.anomalies, formatAnomaly),
    ``,
    `## Recent Suppressed Transients`,
    tableRows(summary.suppressedRows, (r) => `- ${r.timestamp || '?'} session=${r.session} final=${r.final}${r.failure ? ` failure=${r.failure}` : ''} terminalForced=${r.terminalForced} tools=${r.tools} duration=${ms(r.durationMs)}`),
  ].join('\n');
}

function readRows(opts) {
  const text = fs.readFileSync(opts.file, 'utf8');
  const cutoff = opts.sinceHours > 0 ? Date.now() - opts.sinceHours * 60 * 60 * 1000 : 0;
  let lines = text.split(/\r?\n/);
  if (opts.limit > 0) lines = lines.slice(-opts.limit);
  const rows = [];
  const events = [];
  for (const line of lines) {
    const row = parsePiRunSummaryLine(line);
    if (row) {
      if (!row.timestamp || Date.parse(row.timestamp) >= cutoff) rows.push(row);
      continue;
    }
    const event = parsePiOperationalEvent(line);
    if (event && (!event.timestamp || Date.parse(event.timestamp) >= cutoff)) events.push(event);
  }
  return { rows, events };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { rows, events } = readRows(opts);
  const summary = summarize(rows, events);
  if (opts.json) console.log(JSON.stringify({ options: opts, summary, rows, events }, null, 2));
  else console.log(formatMarkdown(summary, opts));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export {
  parsePiRunSummaryLine,
  parsePiOperationalEvent,
  summarize,
  formatMarkdown,
};
