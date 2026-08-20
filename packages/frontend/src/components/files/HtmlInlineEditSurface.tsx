// Owns: HTML preview surface with inline-edit support. Public API: HtmlInlineEditSurface.
// See inline-edit/README.md.
//
// Why this exists:
// HTML files are previewed in a sandboxed iframe (allow-scripts allow-same-origin).
// Selection happens *inside* the iframe — the parent React tree never sees it
// directly. We bridge that gap by injecting a small script (htmlInjector.ts)
// into the iframe document; that script posts selection events back to the
// parent via postMessage. The parent then feeds them into the same useInlineEdit
// state machine the markdown surface uses.
//
// Coordinate translation:
// The iframe reports rects in iframe-local coordinates. Floating UI sits in
// the parent viewport. We add iframe.getBoundingClientRect() top/left offsets
// before passing to useInlineEdit.
//
// Decision: workspace/decisions/2026-05-05-preview-inline-edit.md (Phase 1.5b)

import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useInlineEdit } from './inline-edit/useInlineEdit';
import { SelectionBar } from './inline-edit/SelectionBar';
import { DiffPreview } from './inline-edit/DiffPreview';
import {
  wrapHtmlWithInjector,
  INJECT_MESSAGE_TYPES,
  type IframeSelectionMessage,
} from './inline-edit/htmlInjector';

interface Props {
  content: string;
  filePath: string;
  onContentChange: (next: string) => void;
  /**
   * Fired after a successful apply + disk write. The `info.undo` callable
   * rolls back the last apply for this file — wire it to a toast action so
   * users can revert within ~5s.
   */
  onSaved?: (info: { undo: () => Promise<boolean> }) => void;
  inlineEditDisabled?: boolean;
  /** Tower session id for audit correlation. */
  sessionId?: string | null;
  className?: string;
}

export function HtmlInlineEditSurface({
  content,
  filePath,
  onContentChange,
  onSaved,
  inlineEditDisabled,
  sessionId,
  className,
}: Props) {
  const { t, i18n } = useTranslation('files');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Build a Blob URL with the inject script wired in. We rebuild on every
  // content change so that an applied edit immediately reflects in the iframe.
  // Trade-off: the iframe reloads (scroll position resets). For Phase 1.5b
  // this is acceptable; a smoother in-place update is Phase 2 material.
  const blobUrl = useMemo(() => {
    const wrapped = wrapHtmlWithInjector(content, t('inlineEditOutline.selection'));
    const blob = new Blob([wrapped], { type: 'text/html' });
    return URL.createObjectURL(blob);
  }, [content, i18n.resolvedLanguage, t]);

  // Revoke the blob URL when content changes or component unmounts.
  useEffect(() => {
    return () => {
      try { URL.revokeObjectURL(blobUrl); } catch { /* no-op */ }
    };
  }, [blobUrl]);

  const inlineEdit = useInlineEdit({
    content,
    filePath,
    // No DOM containerRef — selection arrives via postMessage instead.
    onContentChange,
    onSaved,
    disabled: inlineEditDisabled,
    sessionId: sessionId ?? null,
  });

  // We need a stable ref to beginPrompting so the message listener (which
  // outlives renders thanks to its empty-deps array) always sees the latest.
  const beginPromptingRef = useRef(inlineEdit.beginPrompting);
  beginPromptingRef.current = inlineEdit.beginPrompting;

  const cancelRef = useRef(inlineEdit.cancel);
  cancelRef.current = inlineEdit.cancel;

  // setScope ref — closure problem: the message listener is attached
  // once with [] deps, so without a ref the listener would always call
  // the *first render's* setScope, which captures stale state.
  const setScopeRef = useRef(inlineEdit.setScope);
  setScopeRef.current = inlineEdit.setScope;

  // Stage ref — needed by the CLEAR-message branch below to skip cancel
  // while a request is in flight or the diff modal is open. Without this
  // guard, an unrelated click inside the iframe (which surfaces as a
  // CLEAR message) would abort the AI fetch the user already committed to.
  const stageRef = useRef(inlineEdit.stage);
  stageRef.current = inlineEdit.stage;

  // Listen for selection events posted from the iframe. We attach once and
  // dispatch by inspecting iframeRef inside the handler — re-attaching on
  // every render would race with selections that arrive mid-renders.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!e.data || typeof e.data !== 'object') return;

      // Only accept messages from our own iframe. We can't compare origins
      // (Blob iframes get a unique opaque origin), so we compare windows.
      if (iframeRef.current && e.source !== iframeRef.current.contentWindow) {
        return;
      }

      if (e.data.type === INJECT_MESSAGE_TYPES.CLEAR) {
        // User clicked elsewhere inside the iframe.
        //
        // CRITICAL: only dismiss when the bar is in a passive stage
        // (idle / prompting / error). During 'loading' an AI request is in
        // flight that the user already committed to — we must NOT abort it
        // just because they clicked outside the original selection. During
        // 'preview' the diff modal owns the lifecycle; only its own X /
        // Apply / Cancel should close it.
        const stage = stageRef.current;
        if (stage === 'loading' || stage === 'preview') return;
        cancelRef.current();
        return;
      }

      if (e.data.type === INJECT_MESSAGE_TYPES.SCOPE_CLICK) {
        // User clicked one of the outline labels inside the iframe.
        // Direct-manipulation entry point for scope toggle — no
        // SelectionBar pill row needed.
        const scope = e.data.scope;
        if (scope === 'selection' || scope === 'parent') {
          setScopeRef.current(scope);
        }
        return;
      }

      if (e.data.type !== INJECT_MESSAGE_TYPES.SELECTION) return;

      const msg = e.data as IframeSelectionMessage;
      const iframe = iframeRef.current;
      if (!iframe) return;

      const ifrRect = iframe.getBoundingClientRect();
      // Translate iframe-local rect → parent viewport rect.
      const rect = {
        top: msg.rect.top + ifrRect.top,
        left: msg.rect.left + ifrRect.left,
        width: msg.rect.width,
        height: msg.rect.height,
      };

      beginPromptingRef.current({
        text: msg.text,
        rect,
        // Translate the iframe-local last-rect bottom into the parent's
        // viewport so SelectionBar can sit beneath the whole multi-line
        // selection, not on top of line 2+.
        bottomMost:
          typeof msg.bottomMost === 'number' ? msg.bottomMost + ifrRect.top : undefined,
        // Raw-offset path: marker-based capture yields exact byte offsets
        // within the iframe's normalized outerHTML. We forward them so
        // useInlineEdit can skip the hint-matching step entirely.
        rawHtml: msg.rawHtml,
        rawStart: msg.rawStart,
        rawEnd: msg.rawEnd,
        kind: 'html',
        // Wrapping element info (when reported) — enables the "select <tag>
        // as a whole" scope toggle in SelectionBar.
        parentTagName: msg.parentTagName,
        parentRawStart: msg.parentRawStart,
        parentRawEnd: msg.parentRawEnd,
        // Hints are kept around for debugging; useInlineEdit ignores them
        // when raw offsets are present.
        beforeHint: msg.beforeHint || '',
        afterHint: msg.afterHint || '',
      });
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // When the user dismisses the prompt bar from the parent (Esc, click X),
  // also clear the iframe's native selection so it stops looking "active".
  const stage = inlineEdit.stage;
  useEffect(() => {
    if (stage !== 'idle') return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      win.postMessage({ type: INJECT_MESSAGE_TYPES.CANCEL }, '*');
    } catch { /* no-op */ }
  }, [stage]);

  // Phase 1.5g — visual outline overlay. Forward the active scope to the
  // iframe so the inject script can highlight the corresponding outline
  // (cyan dashed for selection, amber solid for parent element). Sending
  // `active: null` removes both outlines — used when the prompt bar isn't
  // visible (idle / loading without a parent target).
  //
  // We deliberately listen to two pieces of state: the stage (so we tear
  // outlines down the moment the prompt bar disappears) and
  // selection.scope (so SelectionBar pill clicks flip active styling
  // without touching the rect). The selection.parent dependency is what
  // re-evaluates when a fresh selection arrives with new boundaries.
  const scope = inlineEdit.selection?.scope;
  const hasParent = !!inlineEdit.selection?.parent;
  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      if (stage === 'idle' || !inlineEdit.selection) {
        win.postMessage({ type: INJECT_MESSAGE_TYPES.OUTLINE_STATE, active: null }, '*');
        return;
      }
      // Default: selection active. The iframe drew outlines on capture
      // already; this message is the source of truth for highlight after.
      win.postMessage(
        {
          type: INJECT_MESSAGE_TYPES.OUTLINE_STATE,
          active: scope === 'parent' ? 'parent' : 'selection',
        },
        '*',
      );
    } catch { /* no-op */ }
  }, [stage, scope, hasParent, inlineEdit.selection]);

  return (
    <div className={className ?? 'absolute inset-0'}>
      <iframe
        ref={iframeRef}
        src={blobUrl}
        className="w-full h-full border-0 bg-white"
        sandbox="allow-scripts allow-same-origin"
        title="html-preview"
      />
      <SelectionBar state={inlineEdit} />
      <DiffPreview state={inlineEdit} />
    </div>
  );
}

export type { IframeSelectionMessage };
