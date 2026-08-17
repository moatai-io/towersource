// Owns: Viewer file-actions popover positioning. Public API: FileActionsMenu.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

interface FileActionsMenuProps {
  children: React.ReactNode;
}

/** Renders file actions above Viewer content by portaling the menu to the viewport. */
export function FileActionsMenu({ children }: FileActionsMenuProps) {
  const { t } = useTranslation('files');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ right: 8, top: 44 });

  const updatePosition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    setPosition({
      right: Math.max(8, window.innerWidth - rect.right),
      top: rect.bottom + 4,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !buttonRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      )
        setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, updatePosition]);

  return (
    <div className="shrink-0">
      <button
        ref={buttonRef}
        type="button"
        className="flex h-8 w-8 items-center justify-center rounded-md border border-surface-700 bg-surface-800 text-lg leading-none text-gray-300 hover:bg-surface-700"
        aria-label={t('moreFileActions')}
        title={t('moreFileActions')}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => {
          updatePosition();
          setOpen((current) => !current);
        }}
      >
        ⋯
      </button>
      {typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            hidden={!open}
            style={{ right: position.right, top: position.top }}
            className="fixed z-[100] flex min-w-40 flex-col gap-1 rounded-lg border border-surface-700 bg-surface-900 p-2 shadow-xl"
          >
            {children}
          </div>,
          document.body,
        )}
    </div>
  );
}
