import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chat-store';
import { computeContextUsageStat, fmtTokensShort } from '../../utils/context-usage';
import { ModelSelector } from '../layout/ModelSelector';

function formatTurnDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function StatusLine({ isTurnActive = false }: { isTurnActive?: boolean }) {
  const { t } = useTranslation('layout');
  const cost = useChatStore(s => s.cost);
  const messages = useChatStore(s => s.messages);
  const lastTurnMetrics = useChatStore(s => s.lastTurnMetrics);
  const context = useMemo(() => computeContextUsageStat({ cost, messages }), [cost, messages]);
  // Persisted assistant metrics are authoritative after reload or session switching.
  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
  const lastDuration = lastAssistant?.durationMs ?? (
    lastAssistant && lastTurnMetrics && Date.now() - lastAssistant.timestamp < Math.max(30_000, lastTurnMetrics.durationMs + 5_000)
      ? lastTurnMetrics.durationMs
      : null
  );
  const percent = Math.round(context.pressurePct ?? context.contextPct);
  const displayUsed = context.pressure?.tokens ?? context.contextUsed;
  const displayMax = context.pressure?.thresholdTokens ?? context.maxTokens;

  return (
    <div data-testid="composer-status-line" className="flex min-w-0 items-center justify-between gap-3 px-2.5 py-1.5 text-[11px] tabular-nums text-surface-400">
      <div className="flex min-w-0 items-center gap-3 overflow-hidden">
        {!isTurnActive && lastDuration != null && <span data-testid="status-line-last-turn-time" className="shrink-0">{formatTurnDuration(lastDuration)}</span>}
        {context.hasContextMetric && context.hasKnownWindow && (
          <span className="inline-flex shrink-0 items-center gap-1.5" title={`${context.pressure ? 'Tower 선제 압축 판단용 컨텍스트' : context.isEstimated ? '추정 입력' : '실제 입력'} · ${t(context.usesCompactionBudget ? 'compactionBudgetUsage' : 'contextUsageValue', { used: fmtTokensShort(displayUsed), window: fmtTokensShort(displayMax), percent })}`}>
            <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-700" role="progressbar" aria-label={t(context.usesCompactionBudget ? 'compactionBudgetUsage' : 'contextUsageValue', { used: fmtTokensShort(displayUsed), window: fmtTokensShort(displayMax), percent })} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
              <span className="block h-full rounded-full bg-primary-400" style={{ width: `${context.pressurePct ?? context.contextPct}%` }} />
            </span>
            <span>{t(context.usesCompactionBudget ? 'compactionBudgetPercent' : 'contextUsedPercent', { percent })}</span>
          </span>
        )}
      </div>
      <ModelSelector dropdownAlign="up" variant="composer" className="shrink-0" />
    </div>
  );
}
