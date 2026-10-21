import { useEffect, useState } from 'react';

const KEYBOARD_OPEN_THRESHOLD_PX = 80;

type MobileKeyboardViewport = {
  height: string;
  keyboardOpen: boolean;
};

export function isEditableElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
  if (element instanceof HTMLInputElement) return !element.disabled && !element.readOnly && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(element.type);
  return element.isContentEditable;
}

export function deriveMobileKeyboardViewport({
  layoutHeight,
  visualHeight,
  offsetTop,
  editableFocused,
}: {
  layoutHeight: number;
  visualHeight: number;
  offsetTop: number;
  editableFocused: boolean;
}): MobileKeyboardViewport {
  const visibleBottom = Math.max(1, Math.round(offsetTop + visualHeight));
  const keyboardInset = Math.max(0, Math.round(layoutHeight - visibleBottom));
  const keyboardOpen = editableFocused && keyboardInset > KEYBOARD_OPEN_THRESHOLD_PX;

  return {
    height: keyboardOpen ? `${visibleBottom}px` : '100dvh',
    keyboardOpen,
  };
}

export function useMobileKeyboardViewport(enabled: boolean): MobileKeyboardViewport & { hideNavigation: boolean } {
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!enabled) { setEditing(false); return; }
    const measureFocus = () => setEditing(isEditableElement(document.activeElement));
    // Also works when visualViewport is missing or both viewport heights shrink together.
    measureFocus();
    document.addEventListener('focusin', measureFocus);
    document.addEventListener('focusout', measureFocus);
    return () => {
      document.removeEventListener('focusin', measureFocus);
      document.removeEventListener('focusout', measureFocus);
    };
  }, [enabled]);
  const [viewport, setViewport] = useState<MobileKeyboardViewport>({
    height: '100dvh',
    keyboardOpen: false,
  });

  useEffect(() => {
    if (!enabled || !window.visualViewport) {
      setViewport({ height: '100dvh', keyboardOpen: false });
      return;
    }

    const visualViewport = window.visualViewport;
    let layoutHeight = Math.max(window.innerHeight, visualViewport.height + visualViewport.offsetTop);
    let frame: number | null = null;

    const measure = () => {
      frame = null;
      const editableFocused = isEditableElement(document.activeElement);
      const visualBottom = visualViewport.height + visualViewport.offsetTop;

      // Browser chrome and orientation changes redefine the layout viewport only
      // while no software keyboard editor is active. Keeping the pre-keyboard
      // baseline prevents iOS Chrome's shrinking innerHeight from hiding the
      // keyboard inset that we need to detect.
      if (!editableFocused) {
        layoutHeight = Math.max(window.innerHeight, visualBottom);
      }

      setViewport(deriveMobileKeyboardViewport({
        layoutHeight,
        visualHeight: visualViewport.height,
        offsetTop: visualViewport.offsetTop,
        editableFocused,
      }));
    };

    const scheduleMeasure = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('resize', scheduleMeasure);
    window.addEventListener('focusin', scheduleMeasure);
    window.addEventListener('focusout', scheduleMeasure);
    visualViewport.addEventListener('resize', scheduleMeasure);
    visualViewport.addEventListener('scroll', scheduleMeasure);

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener('focusin', scheduleMeasure);
      window.removeEventListener('focusout', scheduleMeasure);
      visualViewport.removeEventListener('resize', scheduleMeasure);
      visualViewport.removeEventListener('scroll', scheduleMeasure);
    };
  }, [enabled]);

  return { ...viewport, hideNavigation: enabled && (editing || viewport.keyboardOpen) };
}
