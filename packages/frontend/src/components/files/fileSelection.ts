// Owns: file-viewer selection helpers for keyboard shortcuts.
// Public API: shouldUseFileBodySelectAll, selectElementTextContents.

/**
 * Returns true when the keyboard target should keep its native select-all
 * behavior instead of selecting the surrounding file preview body.
 */
export function isEditableSelectionTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  if (!element) return false;

  return Boolean(
    element.closest('input, textarea, select, [contenteditable], .cm-editor'),
  );
}

/**
 * Decide whether Mod+A should select only the file body for a rendered preview.
 * This intentionally avoids stealing select-all from text inputs/editors and
 * from focused toolbar/header controls.
 */
export function shouldUseFileBodySelectAll(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'target'>,
  selectableRoot: HTMLElement | null,
  doc: Document = document,
): selectableRoot is HTMLElement {
  if (!selectableRoot) return false;
  if (event.altKey) return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  if (event.key.toLowerCase() !== 'a') return false;
  if (isEditableSelectionTarget(event.target)) return false;

  const activeElement = doc.activeElement;
  const targetElement = event.target instanceof Element ? event.target : null;
  const focusIsPageBody = !activeElement || activeElement === doc.body || activeElement === doc.documentElement;
  const focusIsInsideFileBody = activeElement instanceof Element && selectableRoot.contains(activeElement);
  const targetIsInsideFileBody = targetElement ? selectableRoot.contains(targetElement) : false;

  return focusIsPageBody || focusIsInsideFileBody || targetIsInsideFileBody;
}

/** Select exactly the text contents of a rendered file body. */
export function selectElementTextContents(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection) return false;

  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
