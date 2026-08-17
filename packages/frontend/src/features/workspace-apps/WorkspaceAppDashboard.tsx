import React from 'react';
import type { WorkspaceAppMetric } from './workspace-app-definition';

function toneClass(tone: WorkspaceAppMetric['tone']): string {
  switch (tone) {
    case 'primary': return 'border-blue-200 bg-blue-50 text-blue-900 dark:border-primary-500/25 dark:bg-primary-500/10 dark:text-primary-100';
    case 'warn': return 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100';
    case 'success': return 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-100';
    default: return 'border-slate-200 bg-slate-50 text-slate-900 dark:border-surface-800 dark:bg-surface-850/60 dark:text-surface-100';
  }
}

export function WorkspaceAppDashboard({ metrics }: { metrics: WorkspaceAppMetric[] }) {
  return (
    <section className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => (
        <article key={metric.id} className={`rounded-xl border px-3 py-2.5 shadow-sm ${toneClass(metric.tone)}`}>
          <div className="text-[11px] font-bold uppercase tracking-[0.08em] opacity-70">{metric.label}</div>
          <div className="mt-1 text-xl font-bold tabular-nums">{metric.value}</div>
          <div className="mt-0.5 text-[12px] opacity-70">{metric.delta}</div>
        </article>
      ))}
    </section>
  );
}
