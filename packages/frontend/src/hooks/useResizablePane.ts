import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

interface ResizeCalculationContext {
  clientX: number;
  startX: number;
  startValue: number;
}

interface UseResizablePaneOptions {
  value: number;
  calculateValue: (context: ResizeCalculationContext) => number;
  onResize?: (value: number) => void;
  onResizeEnd?: (value: number) => void;
  onPreview?: (value: number, startValue: number) => void;
  stopPropagation?: boolean;
}

interface UseResizablePaneResult {
  isResizing: boolean;
  startResize: (event: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * Owns the pointer lifecycle shared by horizontal pane resize handles.
 * Callers retain pane-specific width calculation, live preview, and persistence.
 */
export function useResizablePane({
  value,
  calculateValue,
  onResize,
  onResizeEnd,
  onPreview,
  stopPropagation = false,
}: UseResizablePaneOptions): UseResizablePaneResult {
  const [isResizing, setIsResizing] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const finishActiveResize = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  useEffect(() => finishActiveResize, [finishActiveResize]);

  const startResize = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    if (stopPropagation) event.stopPropagation();
    finishActiveResize();

    const startX = event.clientX;
    const startValue = value;
    let latestValue = startValue;
    let animationFrame = 0;

    const calculate = (clientX: number) => calculateValue({ clientX, startX, startValue });
    const renderPreview = () => {
      animationFrame = 0;
      onPreview?.(latestValue, startValue);
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
      latestValue = calculate(moveEvent.clientX);
      onResize?.(latestValue);
      if (onPreview && !animationFrame) animationFrame = window.requestAnimationFrame(renderPreview);
    };
    const cleanup = () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setIsResizing(false);
    };
    const handlePointerUp = (upEvent: PointerEvent) => {
      latestValue = calculate(upEvent.clientX);
      onResizeEnd?.(latestValue);
      cleanup();
      cleanupRef.current = null;
    };

    cleanupRef.current = cleanup;
    setIsResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
    window.addEventListener('pointercancel', handlePointerUp, { once: true });
  }, [calculateValue, finishActiveResize, onPreview, onResize, onResizeEnd, stopPropagation, value]);

  return { isResizing, startResize };
}
