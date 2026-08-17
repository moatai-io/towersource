import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const VIEWPORT_PADDING = 8;

export function clampContextMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  padding = VIEWPORT_PADDING,
) {
  return {
    left: Math.max(padding, Math.min(x, viewportWidth - width - padding)),
    top: Math.max(padding, Math.min(y, viewportHeight - height - padding)),
  };
}

interface ViewportContextMenuProps extends React.HTMLAttributes<HTMLDivElement> {
  x: number;
  y: number;
  offset?: number;
}

/**
 * Renders pointer-anchored menus at document.body so clientX/clientY always
 * share the same viewport coordinate system, even below transformed layouts.
 */
export function ViewportContextMenu({
  x,
  y,
  offset = 2,
  style,
  children,
  ...props
}: ViewportContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x + offset, top: y + offset });

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPosition(clampContextMenuPosition(
      x + offset,
      y + offset,
      rect.width,
      rect.height,
      window.innerWidth,
      window.innerHeight,
    ));
  }, [x, y, offset, children]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div ref={ref} {...props} style={{ ...style, ...position }}>
      {children}
    </div>,
    document.body,
  );
}
