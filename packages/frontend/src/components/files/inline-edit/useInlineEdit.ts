// Owns: inline-edit state machine + selection capture. Public API: useInlineEdit, InlineEditState.
// See README.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type InlineEditStage =
  | 'idle'
  | 'prompting' // floating bar visible, user typing instruction
  | 'loading'   // request in flight
  | 'preview'   // diff shown, awaiting Apply / Cancel
  | 'error';

export type SelectionKind = 'text' | 'html';

/**
 * What the AI's output does to the selection:
 *   - 'replace' (default): selection is removed and AI output takes its place.
 *   - 'insertBefore': selection stays; AI output is inserted just before it.
 *   - 'insertAfter': selection stays; AI output is inserted just after it.
 *
 * `'inside'` (appendChild) is reserved for a future phase — it requires
 * locating the selection's container element's closing tag, which is more
 * involved and only meaningful for HTML selections.
 */
export type EditMode = 'replace' | 'insertBefore' | 'insertAfter';

export type SelectionScope = 'selection' | 'parent';

/** Wrapping element info — present when the iframe surface detected a
 *  meaningful parent (not body/html). The user can toggle between scoping
 *  edits to the inner selection vs the entire wrapping element. */
export interface ParentScopeInfo {
  tagName: string;
  /** Raw start of the *parent element's* outerHTML in contentSnapshot. */
  rawStart: number;
  /** Raw end of the *parent element's* outerHTML in contentSnapshot. */
  rawEnd: number;
  /** Raw start of the original inner selection. We keep these so toggling
   *  back to `'selection'` scope is exact. */
  innerStart: number;
  innerEnd: number;
}

export interface SelectionInfo {
  /** Plain text the user selected. */
  text: string;
  /**
   * Bounding rect — the FIRST client rect of the selection range. Anchors
   * the floating bar's left edge to where the selection visually starts.
   * For multi-line selections this is just the first line's box.
   */
  rect: { top: number; left: number; width: number; height: number };
  /**
   * Bottom of the LAST client rect of the selection. For multi-line
   * selections this is past `rect.top + rect.height` — the bar uses it so
   * the "place below" branch sits beneath the entire selection, not under
   * the first line (which would cover the second line). Falls back to
   * `rect.top + rect.height` when missing.
   */
  bottomMost?: number;
  /** Index into the underlying content where the selection starts. */
  start: number;
  /** Index into the underlying content where the selection ends. */
  end: number;
  /**
   * Optional snapshot of the content this selection refers to. HTML iframe
   * surfaces capture the iframe-normalized outerHTML at the moment of
   * selection — that's the source we slice with start/end and patch on
   * apply, even if the disk raw differs.
   */
  contentSnapshot?: string;
  /** 'text' (markdown/txt) or 'html' (iframe surface). Drives backend SYSTEM_PROMPT. */
  kind?: SelectionKind;
  /** What the AI output does to the selection. Defaults to 'replace'. */
  editMode?: EditMode;
  /** Wrapping element info, if the surface reported one. Lets the UI offer
   *  a "select <tag> as a whole" toggle without re-dragging. */
  parent?: ParentScopeInfo;
  /** Which scope is currently active. 'selection' is the user's drag,
   *  'parent' expands to the wrapping element's outerHTML boundary. */
  scope?: SelectionScope;
}

export interface ExternalSelectionInput {
  /** Plain text the user selected, exactly as it appears in the rendered DOM. */
  text: string;
  /** Selection bounding rect (FIRST client rect), **already translated to viewport coordinates** by the caller. */
  rect: { top: number; left: number; width: number; height: number };
  /** Optional viewport-space bottom of the LAST client rect. See SelectionInfo.bottomMost. */
  bottomMost?: number;
  /**
   * ~120 chars of DOM text immediately before the selection. Used by the
   * legacy hint-matching path (markdown surface). Optional when the caller
   * provides explicit `rawHtml` + offsets instead.
   */
  beforeHint?: string;
  /** ~120 chars of DOM text immediately after the selection. */
  afterHint?: string;
  /**
   * Direct raw-offset path (HTML iframe surface). When provided, bypasses
   * `locateSelection` entirely:
   *   - `rawHtml` becomes the contentSnapshot used for slicing/applying.
   *   - `rawStart`/`rawEnd` are byte offsets within `rawHtml`.
   * The text at `rawHtml.slice(rawStart, rawEnd)` is what the AI receives
   * as SELECTION (raw HTML markup, not plain text).
   */
  rawHtml?: string;
  rawStart?: number;
  rawEnd?: number;
  /** Selection kind. Defaults to 'text'. Set to 'html' to enable HTML SYSTEM_PROMPT. */
  kind?: SelectionKind;
  /** Wrapping element info from the iframe inject script (when meaningful). */
  parentTagName?: string;
  parentRawStart?: number;
  parentRawEnd?: number;
}

export interface InlineEditState {
  stage: InlineEditStage;
  selection: SelectionInfo | null;
  instruction: string;
  setInstruction: (v: string) => void;
  /** Active edit mode for the current selection. submit/apply use it to
   *  route the request and patch.
   *
   *  @deprecated (Phase 1.5h, 2026-05-05) — UI no longer surfaces a mode
   *  picker. Always 'replace' in practice. Backend SYSTEM_PROMPT_HTML_INSERT
   *  paths remain in case the picker is reintroduced via a future toggle.
   */
  editMode: EditMode;
  /** @deprecated see `editMode`. Kept for API compatibility; no caller in
   *  the current UI invokes it. */
  setEditMode: (m: EditMode) => void;
  /** Toggle between scoping edits to the user's drag ('selection') and the
   *  wrapping element ('parent'). No-op if the current selection has no
   *  parent info (markdown, or HTML selections directly under body). */
  setScope: (scope: SelectionScope) => void;
  replacement: string | null;
  error: string | null;
  model: string | null;
  /** Submit the current instruction, optionally using an immediate DOM/chip value. */
  submit: (immediateInstruction?: string) => Promise<void>;
  /** Apply the current replacement to the file. */
  apply: () => Promise<void>;
  /**
   * Cancel/dismiss any active state, returning to idle. The current
   * instruction is stashed as a draft and restored on the next prompting.
   * Pass `true` to forcibly drop the draft (used internally after a
   * successful apply); external callers can omit the argument.
   */
  cancel: (clearDraft?: boolean) => void;
  /**
   * Programmatic entry point used by surfaces that can't rely on DOM `mouseup`
   * — e.g. an iframe HTML preview that ships its selection across postMessage.
   * Caller is responsible for viewport-coordinate translation.
   */
  beginPrompting: (input: ExternalSelectionInput) => void;
  /**
   * Pop the most recent pre-apply snapshot for the active filePath off the
   * undo stack and write it back. Returns `true` on success, `false` if the
   * stack was empty or the write failed. Same callable is also passed to the
   * `onSaved` toast action and triggered by ⌘Z while idle.
   */
  undoLast: () => Promise<boolean>;
  /** True when the active filePath has at least one undo snapshot. UI uses
   *  this to show / hide a persistent ↶ button next to the prompt input. */
  canUndo: boolean;
}

interface UseInlineEditArgs {
  /** Raw file content as currently loaded (must be the same string used to render). */
  content: string;
  /** Absolute file path (matches backend expectations). */
  filePath: string;
  /**
   * Container element wrapping the previewed content. The hook attaches a
   * `mouseup` listener here for DOM-based surfaces (markdown). Pass `null` /
   * an empty ref for iframe-based surfaces — those use `beginPrompting()`
   * instead.
   */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** Called after a successful apply with the new full content. */
  onContentChange: (next: string) => void;
  /**
   * Called after content was successfully written to disk. The `info` argument
   * carries an `undo` callback the caller can wire to a toast action button —
   * invoking it pops the most recent pre-apply snapshot for this filePath off
   * the undo stack and writes it back. `undo()` resolves to `true` on success,
   * `false` if the stack is empty or the write failed.
   */
  onSaved?: (info: { undo: () => Promise<boolean> }) => void;
  /** Optional Tower session id for audit correlation. */
  sessionId?: string | null;
  /** Disable the whole feature (e.g. during loading or for read-only roles). */
  disabled?: boolean;
}

const HINT_LEN = 30; // chars of before/after used to disambiguate multi-match
// Generous context window — the model is the bottleneck, not bandwidth, and a
// few hundred tokens of surrounding prose noticeably improves tone matching
// for long markdown documents. Backend caps at LIMITS.maxContextChars (2000),
// so any larger value is harmless (it gets sliced server-side).
const CONTEXT_LEN = 1200;

/**
 * Locate `selectionText` inside `content`. If multiple matches exist, use the
 * surrounding text from the DOM as a hint to pick the right one.
 *
 * Returns null if not found, "ambiguous" if we can't pick a unique match.
 */
function locateSelection(
  content: string,
  selectionText: string,
  beforeHint: string,
  afterHint: string,
): { start: number; end: number } | { error: 'not_found' | 'ambiguous' } {
  if (!selectionText) return { error: 'not_found' };

  // Collect every occurrence in the raw content.
  const positions: number[] = [];
  let i = 0;
  while (i <= content.length - selectionText.length) {
    const pos = content.indexOf(selectionText, i);
    if (pos < 0) break;
    positions.push(pos);
    i = pos + 1;
  }

  if (positions.length === 0) return { error: 'not_found' };
  if (positions.length === 1) {
    return { start: positions[0], end: positions[0] + selectionText.length };
  }

  // Multi-match. Score each position by how well the surrounding raw text
  // matches the DOM hints. The DOM may contain markdown-stripped text
  // (e.g. **bold** → "bold"), so we compare normalized substrings only.
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const beforeKey = normalize(beforeHint).slice(-HINT_LEN);
  const afterKey = normalize(afterHint).slice(0, HINT_LEN);

  const scored = positions.map((p) => {
    const rawBefore = normalize(content.slice(Math.max(0, p - HINT_LEN * 4), p)).slice(-HINT_LEN);
    const rawAfter = normalize(content.slice(p + selectionText.length, p + selectionText.length + HINT_LEN * 4)).slice(0, HINT_LEN);
    let score = 0;
    if (beforeKey && rawBefore.endsWith(beforeKey)) score += 2;
    else if (beforeKey && rawBefore.includes(beforeKey)) score += 1;
    if (afterKey && rawAfter.startsWith(afterKey)) score += 2;
    else if (afterKey && rawAfter.includes(afterKey)) score += 1;
    return { p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  if (scored[0].score > 0 && (scored.length === 1 || scored[0].score > scored[1].score)) {
    return { start: scored[0].p, end: scored[0].p + selectionText.length };
  }
  return { error: 'ambiguous' };
}

/**
 * Read up to `len` characters of text immediately before/after the given DOM
 * selection. Used as a hint for raw-content matching.
 */
function readDomHints(sel: Selection, container: HTMLElement, len: number): { before: string; after: string } {
  const range = sel.getRangeAt(0);

  // before: walk backwards from range.startContainer/startOffset within container
  const before = (() => {
    const r = document.createRange();
    r.selectNodeContents(container);
    r.setEnd(range.startContainer, range.startOffset);
    const text = r.toString();
    return text.slice(-len);
  })();

  const after = (() => {
    const r = document.createRange();
    r.selectNodeContents(container);
    r.setStart(range.endContainer, range.endOffset);
    const text = r.toString();
    return text.slice(0, len);
  })();

  return { before, after };
}

export function useInlineEdit(args: UseInlineEditArgs): InlineEditState {
  const { content, filePath, containerRef, onContentChange, onSaved, sessionId, disabled } = args;

  const [stage, setStage] = useState<InlineEditStage>('idle');
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [instruction, setInstruction] = useState('');
  const [replacement, setReplacement] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<EditMode>('replace');
  // Whether the active filePath has at least one undo snapshot. Drives the
  // ↶ button in SelectionBar's footer (always-visible undo, complementing
  // the 5s sonner toast). Updated by apply (push), undoLast (pop), and the
  // filePath effect (recheck on file switch).
  const [canUndo, setCanUndo] = useState(false);
  const mtimeRef = useRef<number | null>(null);
  // Draft instructions, keyed by filePath. Survives cancel → next prompting,
  // AND survives switching between files within the same ContextPanel: when
  // the user comes back to a file they had been editing, their unsubmitted
  // instruction is restored on the next selection.
  // Lives in a ref so changes don't trigger re-renders mid-input. The Map's
  // identity is stable across renders; only its contents mutate.
  const draftMapRef = useRef<Map<string, string>>(new Map());
  // Undo stack — keyed by filePath, holds pre-apply content snapshots so the
  // user can roll back the last N inline-edit applies. Separate from drafts;
  // populated only on successful apply (after disk write). FIFO trim at 10.
  const undoStackRef = useRef<Map<string, string[]>>(new Map());
  const UNDO_STACK_MAX = 10;
  // Mirrors `instruction` state into a ref so the filePath effect's cleanup
  // function can read the current value without a stale closure.
  const instructionRef = useRef<string>('');
  useEffect(() => {
    instructionRef.current = instruction;
  }, [instruction]);
  // Tracks the active fetch so we can abort on cancel / filePath change /
  // unmount. Without this, a slow AI response can race against a file switch
  // and overwrite the wrong file's content.
  const activeAbortRef = useRef<AbortController | null>(null);
  // Stable identity for the file the active request was started against.
  // Used to discard responses that arrive after the user navigated away.
  const requestFilePathRef = useRef<string | null>(null);
  // Tracks whether the component is still mounted so we can guard setState
  // calls that resolve after unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Abort any pending request on unmount.
      activeAbortRef.current?.abort();
      activeAbortRef.current = null;
    };
  }, []);

  // Reset to idle when the file changes underneath us. Any in-flight
  // request is aborted so its response can't bleed into the new file.
  // Drafts are NOT wiped — they live in draftMapRef under the previous
  // filePath key. The cleanup function (below) snapshots the current
  // instruction into the Map just before this effect re-runs, so when the
  // user switches back the draft is still there.
  useEffect(() => {
    activeAbortRef.current?.abort();
    activeAbortRef.current = null;
    requestFilePathRef.current = null;
    setStage('idle');
    setSelection(null);
    setInstruction('');
    setReplacement(null);
    setError(null);
    setEditMode('replace');
    // Recompute canUndo for the new file — undoStackRef survives file
    // switches (each filePath has its own per-file stack), so the new file
    // may already have snapshots from earlier in the session.
    const newStack = undoStackRef.current.get(filePath);
    setCanUndo(!!newStack && newStack.length > 0);
    mtimeRef.current = null;

    return () => {
      // filePath is about to change (or component is unmounting). Stash the
      // instruction the user was typing under the path we're leaving so they
      // get it back when they return. Empty/whitespace drafts aren't worth
      // remembering.
      const leaving = filePath;
      const text = instructionRef.current;
      if (leaving && text.trim()) {
        draftMapRef.current.set(leaving, text);
      }
    };
  }, [filePath]);

  /**
   * Dismiss the prompt/diff/error UI. Preserves any in-progress instruction
   * as a draft so the user gets it back the next time they select something.
   * The native browser selection is also cleared.
   *
   * `clearDraft: true` forces the draft to be wiped (used after a successful
   * apply, or when switching files).
   */
  /**
   * Toggle the selection's scope between the user's drag ('selection') and
   * the wrapping element's outerHTML boundary ('parent'). Updates the live
   * `start`/`end` offsets so submit/apply target the requested scope.
   *
   * Common case: user dragged "여기를 눌러보세요" (button inner text), wants
   * to delete the button itself. Switching scope to 'parent' expands the
   * patch range to cover `<button>...</button>`, so an empty AI output
   * removes the whole element.
   */
  const setScope = useCallback((scope: SelectionScope) => {
    setSelection((sel) => {
      if (!sel || !sel.parent) return sel;
      if (sel.scope === scope) return sel;
      if (scope === 'parent') {
        return { ...sel, scope, start: sel.parent.rawStart, end: sel.parent.rawEnd };
      }
      return { ...sel, scope, start: sel.parent.innerStart, end: sel.parent.innerEnd };
    });
  }, []);

  const cancel = useCallback((clearDraft = false) => {
    // Abort any in-flight request — Esc / outside-click during loading must
    // actually cancel, not just hide the UI while the response keeps coming.
    activeAbortRef.current?.abort();
    activeAbortRef.current = null;
    requestFilePathRef.current = null;

    // Snapshot whatever the user typed before we wipe the input. Drafts are
    // keyed by the current filePath so switching files doesn't lose them.
    setInstruction((current) => {
      if (clearDraft) {
        // apply succeeded — caller wants a fresh slate for this file.
        draftMapRef.current.delete(filePath);
      } else if (current.trim()) {
        draftMapRef.current.set(filePath, current);
      }
      return '';
    });
    setStage('idle');
    setSelection(null);
    setReplacement(null);
    setError(null);
    try { window.getSelection()?.removeAllRanges(); } catch { /* no-op */ }
  }, [filePath]);

  /**
   * Surface-agnostic entry point. Locates the selection inside the raw content
   * and transitions the state machine into "prompting". DOM mouseup handlers
   * call this after extracting hints/rect, and external sources (iframe
   * postMessage, CodeMirror selection) call it directly.
   */
  const beginPrompting = useCallback((input: ExternalSelectionInput) => {
    if (disabled) return;
    if (stage === 'loading' || stage === 'preview') return;
    if (!input.text.trim()) {
      if (stage === 'prompting') cancel();
      return;
    }

    const kind: SelectionKind = input.kind ?? 'text';
    let nextSelection: SelectionInfo;

    // Path A: caller supplied explicit raw offsets (HTML iframe surface).
    // Use them verbatim — no hint matching, no ambiguity check needed since
    // marker-based capture is exact.
    if (
      typeof input.rawHtml === 'string' &&
      typeof input.rawStart === 'number' &&
      typeof input.rawEnd === 'number' &&
      input.rawEnd >= input.rawStart
    ) {
      const hasParent =
        typeof input.parentTagName === 'string' &&
        input.parentTagName.length > 0 &&
        typeof input.parentRawStart === 'number' &&
        typeof input.parentRawEnd === 'number' &&
        input.parentRawEnd > input.parentRawStart;
      nextSelection = {
        text: input.text,
        rect: input.rect,
        bottomMost: input.bottomMost,
        start: input.rawStart,
        end: input.rawEnd,
        contentSnapshot: input.rawHtml,
        kind,
        scope: 'selection',
        ...(hasParent
          ? {
              parent: {
                tagName: input.parentTagName!,
                rawStart: input.parentRawStart!,
                rawEnd: input.parentRawEnd!,
                innerStart: input.rawStart,
                innerEnd: input.rawEnd,
              },
            }
          : {}),
      };
    } else {
      // Path B: legacy hint-matching (markdown surface, plain text).
      const located = locateSelection(
        content,
        input.text,
        input.beforeHint ?? '',
        input.afterHint ?? '',
      );
      if ('error' in located) {
        setError(
          located.error === 'not_found'
            ? '선택한 텍스트를 원본에서 찾지 못했어요. 여러 단락에 걸친 선택이거나, 마크다운 부호 / HTML 엔티티가 섞인 영역은 아직 지원하지 않아요. 한 단락 안에서 다시 선택해 주세요.'
            : '선택한 텍스트가 파일 안에 여러 번 나와요. 좀 더 큰 범위를 선택해 주세요.',
        );
        setStage('error');
        return;
      }
      nextSelection = {
        text: input.text,
        rect: input.rect,
        bottomMost: input.bottomMost,
        start: located.start,
        end: located.end,
        kind,
      };
    }

    setSelection(nextSelection);
    // New selection always starts in 'replace' mode — most common intent.
    // The user can flip to insertBefore/insertAfter via the picker if needed.
    setEditMode('replace');
    // Restore any draft for *this file* from a previous cancel or tab switch.
    // The draft survives moving to other files within the same ContextPanel:
    // come back here and it's still waiting on the next selection.
    const restored = draftMapRef.current.get(filePath) ?? '';
    setInstruction(restored);
    setError(null);
    setStage('prompting');
  }, [content, disabled, stage, cancel, filePath]);

  // DOM-source: capture selections inside the container.
  useEffect(() => {
    if (disabled) return;
    const container = containerRef?.current;
    if (!container) return;

    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    const captureSelection = () => {
      // Defer one tick so mouse, touch, and native long-press selection settle.
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        if (stage === 'loading' || stage === 'preview') return;

        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
          if (stage === 'prompting') cancel();
          return;
        }
        const text = sel.toString();
        if (!text.trim()) {
          if (stage === 'prompting') cancel();
          return;
        }

        // Selection must be entirely inside our container.
        const range = sel.getRangeAt(0);
        if (!container.contains(range.commonAncestorContainer)) {
          return;
        }

        const hints = readDomHints(sel, container, HINT_LEN * 4);
        // Use the FIRST client rect, not the bounding box. For multi-line
        // selections `getBoundingClientRect()` returns a box that spans the
        // entire wrapped width, which anchors the floating bar far above the
        // actual start of the selection. Linear/Notion both anchor on rect[0].
        const rects = range.getClientRects();
        const r = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
        // Last rect's bottom — multi-line selections need this so the
        // "place below" branch sits beneath the WHOLE selection, not under
        // the first line (which would cover line 2+).
        const lastRect = rects.length > 0 ? rects[rects.length - 1] : r;
        const bottomMost = lastRect.bottom;

        beginPrompting({
          text,
          rect: { top: r.top, left: r.left, width: r.width, height: r.height },
          bottomMost,
          beforeHint: hints.before,
          afterHint: hints.after,
        });
      }, 0);
    };

    container.addEventListener('mouseup', captureSelection);
    container.addEventListener('touchend', captureSelection, { passive: true });
    document.addEventListener('selectionchange', captureSelection);
    return () => {
      if (selectionTimer) clearTimeout(selectionTimer);
      container.removeEventListener('mouseup', captureSelection);
      container.removeEventListener('touchend', captureSelection);
      document.removeEventListener('selectionchange', captureSelection);
    };
  }, [containerRef, disabled, stage, cancel, beginPrompting]);

  // Esc → cancel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stage !== 'idle') {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage, cancel]);

  const submit = useCallback(async (immediateInstruction?: string) => {
    const submittedInstruction = (immediateInstruction ?? instruction).trim();
    if (!selection || !submittedInstruction) return;
    setStage('loading');
    setError(null);

    // Auto-expand scope to the parent element when the user clearly wants
    // to delete the wrapping thing but has only selected its inner text.
    // Heuristic: HTML selection + parent info present + scope still on the
    // inner text + instruction matches a delete keyword. The user can
    // override by clicking the cyan "선택" outline label before submitting
    // (which flips scope back manually).
    let effectiveSelection: SelectionInfo = selection;
    if (
      selection.kind === 'html' &&
      selection.parent &&
      selection.scope !== 'parent' &&
      /지워|없애|삭제|제거|빼\b|remove\b|delete\b/i.test(submittedInstruction)
    ) {
      effectiveSelection = {
        ...selection,
        scope: 'parent',
        start: selection.parent.rawStart,
        end: selection.parent.rawEnd,
      };
      // Sync state so SelectionBar reflects the expanded scope and the
      // iframe outline labels swap their active styling on the next tick.
      setSelection(effectiveSelection);
    }

    // Cancel any previous request and start fresh. Tag this request with the
    // current filePath so a late response can be discarded if the user has
    // navigated away.
    activeAbortRef.current?.abort();
    const controller = new AbortController();
    activeAbortRef.current = controller;
    requestFilePathRef.current = filePath;

    // The base content for slicing depends on selection mode:
    //   - text mode: use the live `content` prop (markdown / txt).
    //   - html mode: use the snapshot captured at selection time so offsets
    //     stay consistent even if the iframe re-renders meanwhile.
    const baseContent = effectiveSelection.contentSnapshot ?? content;
    const beforeContext = baseContent.slice(Math.max(0, effectiveSelection.start - CONTEXT_LEN), effectiveSelection.start);
    const afterContext = baseContent.slice(effectiveSelection.end, effectiveSelection.end + CONTEXT_LEN);
    // For HTML mode the AI receives the raw markup slice; for text mode it
    // receives the plain text the user actually saw.
    const selectionForAi =
      effectiveSelection.kind === 'html'
        ? baseContent.slice(effectiveSelection.start, effectiveSelection.end)
        : effectiveSelection.text;

    try {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch('/api/files/inline-edit', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: filePath,
          selection: selectionForAi,
          beforeContext,
          afterContext,
          instruction: submittedInstruction,
          selectionKind: effectiveSelection.kind ?? 'text',
          editMode,
          sessionId: sessionId ?? null,
        }),
        signal: controller.signal,
      });

      // Stale guard: if the user navigated to a different file or canceled
      // while the request was in flight, drop the response on the floor.
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        requestFilePathRef.current !== filePath
      ) {
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      // Re-check after parsing — the file may have changed during the parse.
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        requestFilePathRef.current !== filePath
      ) {
        return;
      }
      mtimeRef.current = typeof data.mtimeMs === 'number' ? data.mtimeMs : null;
      setReplacement(typeof data.replacement === 'string' ? data.replacement : effectiveSelection.text);
      setModel(typeof data.model === 'string' ? data.model : null);
      setStage('preview');
      // Successful preview — release the controller (apply will create its own).
      activeAbortRef.current = null;
    } catch (err: any) {
      // Aborts are intentional; don't surface them as errors.
      if (err?.name === 'AbortError' || controller.signal.aborted) return;
      if (!mountedRef.current || requestFilePathRef.current !== filePath) return;
      setError(err?.message || 'AI 편집에 실패했어요.');
      setStage('error');
    }
  }, [selection, instruction, content, filePath, sessionId, editMode]);

  /**
   * Pop the last pre-apply snapshot for `filePath` from the undo stack and
   * write it back to disk. Returns `true` on success, `false` if the stack is
   * empty or the network call fails / is aborted. Caller (toast action) uses
   * the boolean to decide whether to show a confirmation toast.
   */
  const undoLast = useCallback(async (): Promise<boolean> => {
    const stack = undoStackRef.current.get(filePath);
    if (!stack || stack.length === 0) return false;
    const previous = stack.pop()!;
    // Mirror the trimmed stack back. Empty stack → drop the key.
    if (stack.length === 0) undoStackRef.current.delete(filePath);
    else undoStackRef.current.set(filePath, stack);
    setCanUndo(stack.length > 0);

    activeAbortRef.current?.abort();
    const controller = new AbortController();
    activeAbortRef.current = controller;
    requestFilePathRef.current = filePath;

    try {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch('/api/files/write', {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: filePath, content: previous }),
        signal: controller.signal,
      });

      // Stale guard mirrors apply()'s pattern. If the user navigated away while
      // the undo write was in flight, drop the response on the floor.
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        requestFilePathRef.current !== filePath
      ) {
        return false;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onContentChange(previous);
      activeAbortRef.current = null;
      return true;
    } catch (err: any) {
      if (err?.name === 'AbortError' || controller.signal.aborted) return false;
      if (!mountedRef.current || requestFilePathRef.current !== filePath) return false;
      setError(err?.message || '되돌리기에 실패했어요.');
      setStage('error');
      return false;
    }
  }, [filePath, onContentChange]);

  // ⌘Z / Ctrl+Z → undo the most recent inline-edit apply for this file.
  // Only active when the inline-edit UI itself is idle — otherwise we'd
  // intercept native CodeMirror undo (Edit mode) and any future contentEditable
  // shortcut. Shift+⌘Z (redo) is intentionally left to the browser/native
  // editor; redo would need a separate stack we don't maintain.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (stage !== 'idle') return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey) return;
      if (e.key !== 'z' && e.key !== 'Z') return;
      const stack = undoStackRef.current.get(filePath);
      if (!stack || stack.length === 0) return;
      e.preventDefault();
      void undoLast();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage, filePath, undoLast]);

  const apply = useCallback(async () => {
    if (!selection || replacement == null) return;
    // HTML mode patches against the iframe snapshot (where offsets came from).
    // Text mode patches against the live markdown content.
    const baseContent = selection.contentSnapshot ?? content;
    let next: string;
    switch (editMode) {
      case 'insertBefore':
        // Selection stays where it was; replacement is glued in just before it.
        next = baseContent.slice(0, selection.start) + replacement + baseContent.slice(selection.start);
        break;
      case 'insertAfter':
        // Selection stays where it was; replacement is glued in just after it.
        next = baseContent.slice(0, selection.end) + replacement + baseContent.slice(selection.end);
        break;
      case 'replace':
      default:
        next = baseContent.slice(0, selection.start) + replacement + baseContent.slice(selection.end);
        break;
    }

    activeAbortRef.current?.abort();
    const controller = new AbortController();
    activeAbortRef.current = controller;
    requestFilePathRef.current = filePath;

    try {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch('/api/files/write', {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: filePath, content: next }),
        signal: controller.signal,
      });

      // Stale guard before mutating store: if the user navigated away while
      // the write was in flight, NEVER call onContentChange — that would
      // overwrite the now-active file's content with this request's payload.
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        requestFilePathRef.current !== filePath
      ) {
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      // Push pre-apply content onto the undo stack BEFORE notifying the caller.
      // Doing it here (after the write succeeds) avoids polluting the stack
      // with snapshots that never made it to disk. FIFO trim keeps memory
      // bounded even for users who edit aggressively.
      const stack = undoStackRef.current.get(filePath) ?? [];
      stack.push(baseContent);
      while (stack.length > UNDO_STACK_MAX) stack.shift();
      undoStackRef.current.set(filePath, stack);
      setCanUndo(true);

      onContentChange(next);
      onSaved?.({ undo: undoLast });
      activeAbortRef.current = null;
      // Apply success → wipe the draft (the user got what they wanted).
      cancel(true);
    } catch (err: any) {
      if (err?.name === 'AbortError' || controller.signal.aborted) return;
      if (!mountedRef.current || requestFilePathRef.current !== filePath) return;
      setError(err?.message || '저장에 실패했어요.');
      setStage('error');
    }
  }, [selection, replacement, content, filePath, onContentChange, onSaved, cancel, editMode, undoLast]);

  return useMemo<InlineEditState>(() => ({
    stage,
    selection,
    instruction,
    setInstruction,
    editMode,
    setEditMode,
    setScope,
    replacement,
    error,
    model,
    canUndo,
    submit,
    apply,
    cancel,
    beginPrompting,
    undoLast,
  }), [stage, selection, instruction, editMode, replacement, error, model, canUndo, submit, apply, cancel, beginPrompting, setScope, undoLast]);
}
