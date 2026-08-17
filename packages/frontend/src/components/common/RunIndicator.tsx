import React from 'react';

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
export function RunIndicator({ size = 'sm', label = '실행 중', className = '' }: RunIndicatorProps) {
  return (
    <span
      className={`tower-run-indicator tower-run-indicator-${size} ${className}`.trim()}
      role={label ? 'status' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      title={label || undefined}
    >
      <span />
      <span />
      <span />
    </span>
  );
}
