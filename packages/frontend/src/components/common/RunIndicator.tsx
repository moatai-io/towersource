import React from 'react';
import { useTranslation } from 'react-i18next';

export type RunIndicatorSize = 'xs' | 'sm' | 'md';

interface RunIndicatorProps {
  /** Visual size for compact surfaces such as tabs, sidebar rows, or message bodies. */
  size?: RunIndicatorSize;
  /** Optional accessible label. Set to empty string only when another nearby label already announces the state. */
  label?: string;
  /** Additional Tailwind/color classes. The dots use currentColor. */
  className?: string;
}

/**
 * Shared Tower running signal: three dots that move in sequence.
 *
 * Uses currentColor so each host surface owns tone/contrast, and only animates
 * transform/opacity so it does not shift layout while a run is active.
 */
export function RunIndicator({ size = 'sm', label, className = '' }: RunIndicatorProps) {
  const { t } = useTranslation('common');
  const resolvedLabel = label === undefined ? t('running') : label;
  return (
    <span
      className={`tower-run-indicator tower-run-indicator-${size} ${className}`.trim()}
      role={resolvedLabel ? 'status' : undefined}
      aria-label={resolvedLabel || undefined}
      aria-hidden={resolvedLabel ? undefined : true}
      title={resolvedLabel || undefined}
    >
      <span />
      <span />
      <span />
    </span>
  );
}
