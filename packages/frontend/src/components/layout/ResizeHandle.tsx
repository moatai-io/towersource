import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface ResizeHandleProps {
  onResize: (width: number) => void;
  defaultWidth?: number;
}

const MIN_WIDTH = 280;
const MAX_WIDTH = 800;
const DEFAULT_WIDTH = 384;

/** Right panel resize handle (measured from right edge of window) */
export function ResizeHandle({ onResize, defaultWidth = DEFAULT_WIDTH }: ResizeHandleProps) {
  const { t } = useTranslation('layout');
  const dragging = useRef(false);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - e.clientX));
      onResize(width);
    };

    const handlePointerUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }, [onResize]);

  const handleDoubleClick = useCallback(() => {
    onResize(defaultWidth);
  }, [onResize, defaultWidth]);

  return (
    <div className="relative w-0 shrink-0 touch-none" aria-hidden="false">
      <div
        className="absolute inset-y-0 -left-1 w-2 cursor-col-resize active:bg-primary-500/10 transition-colors touch-none"
        onPointerDown={handlePointerDown}
        onDoubleClick={handleDoubleClick}
        aria-label={t('resizePanel')}
      />
    </div>
  );
}

const SIDEBAR_MIN_WIDTH = 160;
// Allow the file/session sidebar to expand for long filenames, but keep enough
// room for the main workspace. The effective max is 70% of the viewport.
const SIDEBAR_MAX_VIEWPORT_RATIO = 0.7;
const SIDEBAR_MAX_WIDTH = 1200;
const SIDEBAR_DEFAULT_WIDTH = 336;

/** Left sidebar resize handle (measured from left edge of window) */
export function SidebarResizeHandle({ onResize, defaultWidth = SIDEBAR_DEFAULT_WIDTH }: ResizeHandleProps) {
  const { t } = useTranslation('layout');
  const dragging = useRef(false);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const viewportMaxWidth = Math.floor(window.innerWidth * SIDEBAR_MAX_VIEWPORT_RATIO);
      const maxWidth = Math.min(SIDEBAR_MAX_WIDTH, viewportMaxWidth);
      const width = Math.max(SIDEBAR_MIN_WIDTH, Math.min(maxWidth, e.clientX));
      onResize(width);
    };

    const handlePointerUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }, [onResize]);

  const handleDoubleClick = useCallback(() => {
    onResize(defaultWidth);
  }, [onResize, defaultWidth]);

  return (
    <div className="relative w-0 shrink-0 touch-none" aria-hidden="false">
      <div
        className="absolute inset-y-0 -left-1 w-2 cursor-col-resize active:bg-primary-500/10 transition-colors touch-none"
        onPointerDown={handlePointerDown}
        onDoubleClick={handleDoubleClick}
        aria-label={t('resizeSidebar')}
      />
    </div>
  );
}

export { MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_DEFAULT_WIDTH };
