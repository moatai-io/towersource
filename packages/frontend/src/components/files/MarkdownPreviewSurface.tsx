// Owns: markdown preview surface shared by FileViewerPage and ContextPanel.
// Public API: MarkdownPreviewSurface.
//
// Why this exists:
// Tower has two markdown viewers — `/file-viewer?path=...` (FileViewerPage,
// new-tab standalone) and the main UI right panel (ContextPanel, tabbed).
// They share the same render path (ReactMarkdown + rehypeRaw + rehypeHighlight
// + mermaid splitting) and the same inline-edit integration. Keeping that
// logic in one place prevents drift — e.g. adding txt/html adapters in Phase
// 1.5 only touches one file.
//
// What's NOT shared:
// - `mdComponents` (caller passes in). The two viewers want different link
//   semantics: ContextPanel opens links in a new tab via file-store;
//   FileViewerPage is standalone and resolves images relative to the file.
// - The outer scroll container className (caller controls layout).
//
// Decision: workspace/decisions/2026-05-05-preview-inline-edit.md

import { useRef, type CSSProperties } from 'react';
import { MarkdownReadSurface } from './MarkdownReadSurface';
import { useInlineEdit } from './inline-edit/useInlineEdit';
import { SelectionBar } from './inline-edit/SelectionBar';
import { DiffPreview } from './inline-edit/DiffPreview';
import { MarkdownDirectEditSurface } from './direct-edit/MarkdownDirectEditSurface';

interface Props {
  /** Raw markdown text. Must match what was loaded from disk. */
  content: string;
  /** Absolute file path; used by inline-edit when calling the backend. */
  filePath: string;
  /** Called after a successful inline-edit apply with the full updated content. */
  onContentChange: (next: string) => void;
  /** ReactMarkdown components map (caller-supplied — link/image semantics differ between viewers). */
  components: any;
  /**
   * Optional toast/feedback hook fired after the new content is written to disk.
   * inline-edit calls /api/files/write itself; this just lets the caller surface a UI cue.
   * The `info.undo` callback rolls back the last apply for this file — wire it
   * to a toast action button so users can revert within ~5s.
   */
  onSaved?: (info: { undo: () => Promise<boolean> }) => void;
  /** Feature flag. Default false keeps the preserved inline-edit module bypassed. */
  inlineEditEnabled?: boolean;
  /** Feature flag. Default false renders read-only preview unless inline edit is enabled. */
  previewDirectEditEnabled?: boolean;
  /** Disable inline-edit selection capture (e.g. while loading or for read-only roles). */
  inlineEditDisabled?: boolean;
  /** Outer wrapper className. Defaults to a sensible prose layout. */
  className?: string;
  /** Optional outer wrapper style, used for viewer font-size zoom. */
  style?: CSSProperties;
  /** Optional Tower session id for audit correlation. */
  sessionId?: string | null;
}

/**
 * Renders a markdown document with inline-edit selection support.
 *
 * The component owns the container ref so that `useInlineEdit` can attach a
 * `mouseup` listener and gate selection capture to its own subtree. The
 * SelectionBar and DiffPreview are rendered as siblings (fixed-positioned)
 * — they don't need to live inside the scroll container.
 */
function MarkdownInlineEditSurface({
  content,
  filePath,
  onContentChange,
  components,
  onSaved,
  inlineEditDisabled,
  className,
  sessionId,
  style,
}: Props) {
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const inlineEdit = useInlineEdit({
    content,
    filePath,
    containerRef: previewContainerRef,
    onContentChange,
    onSaved,
    disabled: inlineEditDisabled,
    sessionId: sessionId ?? null,
  });

  return (
    <>
      <MarkdownReadSurface
        content={content}
        components={components}
        containerRef={previewContainerRef}
        className={className}
        style={style}
      />
      <SelectionBar state={inlineEdit} />
      <DiffPreview state={inlineEdit} />
    </>
  );
}

export function MarkdownPreviewSurface(props: Props) {
  const {
    content,
    components,
    className,
    style,
    inlineEditEnabled = false,
    previewDirectEditEnabled = false,
    onContentChange,
  } = props;

  if (previewDirectEditEnabled) {
    return (
      <MarkdownDirectEditSurface
        content={content}
        components={components}
        onContentChange={onContentChange}
        className={className}
        style={style}
      />
    );
  }

  if (!inlineEditEnabled) {
    return <MarkdownReadSurface content={content} components={components} className={className} style={style} />;
  }

  return <MarkdownInlineEditSurface {...props} />;
}
