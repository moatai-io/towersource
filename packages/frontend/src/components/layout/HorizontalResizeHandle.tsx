import React, { useCallback, useRef } from 'react';

interface HorizontalResizeHandleProps {
  onResize: (height: number) => void;
  defaultHeight?: number;
  minHeight?: number;
  maxHeight?: number;
}

const DEFAULT_HEIGHT = Math.round(window.innerHeight * 0.7);
const MIN_HEIGHT = 200;

export function HorizontalResizeHandle({
  onResize,
  defaultHeight = DEFAULT_HEIGHT,
  minHeight = MIN_HEIGHT,
  maxHeight,
}: HorizontalResizeHandleProps) {
  const dragging = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      // Header is ~48px, so offset from top of main area
      const headerHeight = 48;
      const max = maxHeight || window.innerHeight - 200;
      const height = Math.max(minHeight, Math.min(max, e.clientY - headerHeight));
      onResize(height);
    };

    const handleMouseUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [onResize, minHeight, maxHeight]);

  const handleDoubleClick = useCallback(() => {
    onResize(defaultHeight);
  }, [onResize, defaultHeight]);

  return (
    <div
      className="h-1.5 cursor-row-resize hover:bg-primary-500/30 active:bg-primary-500/50 transition-colors shrink-0 relative group"
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
    >
      <div className="absolute inset-x-0 top-0 h-px bg-surface-800 group-hover:bg-primary-500/50 transition-colors" />
    </div>
  );
}
