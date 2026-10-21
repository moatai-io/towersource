import React, { useLayoutEffect, useRef, useState } from 'react';

interface FadeOverflowTextProps extends React.HTMLAttributes<HTMLSpanElement> {
  children: React.ReactNode;
}

/** Applies the trailing text fade only when the rendered content actually overflows. */
export function FadeOverflowText({ children, className = '', ...props }: FadeOverflowTextProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setOverflowing(element.scrollWidth > element.clientWidth + 1);
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [children]);

  return (
    <span
      ref={ref}
      data-overflowing={overflowing ? 'true' : 'false'}
      className={`fade-overflow-text ${className}`.trim()}
      {...props}
    >
      {children}
    </span>
  );
}
