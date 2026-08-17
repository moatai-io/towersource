import { describe, expect, it } from 'vitest';
import {
  formatMarkdown,
  parsePiOperationalEvent,
  parsePiRunSummaryLine,
  summarize,
} from '../scripts/pi-run-summary-report.mjs';

describe('pi-run-summary-report', () => {
  it('parses PiRunSummary lines with PM2 prefixes and context usage', () => {
    const row = parsePiRunSummaryLine('0|tower-pr | 2026-06-01 00:01:00: [PiRunSummary] session=a4b79c4c model=litellm-responses/smartest final=aborted failure=transient_transport iterations=6 tools=4 terminalForced=true suppressed=true ctx=87175/272000 durationMs=72212');
    expect(row.session).toBe('a4b79c4c');
    expect(row.model).toBe('litellm-responses/smartest');
    expect(row.final).toBe('aborted');
    expect(row.failure).toBe('transient_transport');
    expect(row.iterations).toBe(6);
    expect(row.tools).toBe(4);
    expect(row.terminalForced).toBe(true);
    expect(row.suppressed).toBe(true);
    expect(row.contextUsed).toBe(87175);
    expect(row.contextWindow).toBe(272000);
    expect(row.contextPct).toBeCloseTo(87175 / 272000);
    expect(row.durationMs).toBe(72212);
  });

  it('parses operational Pi events for non-summary signals', () => {
    expect(parsePiOperationalEvent('[Pi] transient transport error suppressed (prompt-rejected); session=abcd error=stream_incomplete')?.type).toBe('transient_suppressed');
    expect(parsePiOperationalEvent('[Pi] closing terminalizer firing: session=abcd why=x timeout=30000ms')?.type).toBe('closing_terminalizer');
    expect(parsePiOperationalEvent('[Pi] force terminalizing run: session=abcd why=x stop=error')?.type).toBe('force_terminalize');
    expect(parsePiOperationalEvent('[Pi] run() starting: session=abcd watchdog=idle3600s/block7200s')).toBeUndefined();
    expect(parsePiOperationalEvent('[Pi] prompt() rejected: session=abcd error=x watchdog={"reason":"idle-timeout"}')?.type).toBe('watchdog');
  });

  it('summarizes outcomes, failures, models, durations, and context risk', () => {
    const rows = [
      parsePiRunSummaryLine('2026-06-01 00:00:01: [PiRunSummary] session=s1 model=litellm-responses/smartest final=complete iterations=1 tools=0 terminalForced=false suppressed=false ctx=100/1000 durationMs=1000'),
      parsePiRunSummaryLine('2026-06-01 00:00:02: [PiRunSummary] session=s2 model=litellm-responses/smartest final=aborted failure=transient_transport iterations=12 tools=11 terminalForced=true suppressed=true ctx=900/1000 durationMs=90000'),
    ];
    const summary = summarize(rows, [{ type: 'transient_suppressed' }]);
    expect(summary.total).toBe(2);
    expect(summary.finalCounts).toContainEqual(['complete', 1]);
    expect(summary.finalCounts).toContainEqual(['aborted', 1]);
    expect(summary.failureCounts).toContainEqual(['transient_transport', 1]);
    expect(summary.modelCounts).toContainEqual(['litellm-responses/smartest', 2]);
    expect(summary.eventCounts).toContainEqual(['transient_suppressed', 1]);
    expect(summary.suppressed).toBe(1);
    expect(summary.terminalForced).toBe(1);
    expect(summary.context.near80Count).toBe(1);
    expect(summary.health.verdict).toBe('degraded');
    expect(summary.sessionRollups.find((s) => s.session === 's2')).toMatchObject({
      turns: 1,
      aborted: 1,
      suppressed: 1,
      terminalForced: 1,
    });
    expect(summary.anomalies.some((a) => a.type === 'context_90')).toBe(true);
    expect(summary.anomalies.some((a) => a.type === 'terminal_forced')).toBe(true);
    const markdown = formatMarkdown(summary, { file: 'x.log', sinceHours: 24 });
    expect(markdown).toContain('Pi Run Summary Report');
    expect(markdown).toContain('## Health Verdict');
    expect(markdown).toContain('## Session Rollup');
    expect(markdown).toContain('## Recent Anomalies');
  });

  it('raises health verdicts for fatal and watchdog signals', () => {
    const rows = [
      parsePiRunSummaryLine('2026-06-01 00:00:01: [PiRunSummary] session=s1 model=litellm-responses/smartest final=error failure=unknown_fatal iterations=1 tools=0 terminalForced=false suppressed=false ctx=100/1000 durationMs=1000'),
    ];
    const summary = summarize(rows, [{ type: 'watchdog' }]);
    expect(summary.health.verdict).toBe('critical');
    expect(summary.health.reasons.join(' ')).toContain('fatal');
    expect(summary.anomalies.some((a) => a.severity === 'critical')).toBe(true);
  });
});
