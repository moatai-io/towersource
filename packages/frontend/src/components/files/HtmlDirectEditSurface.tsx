// Owns: source-backed direct text editing for HTML iframe preview.
// Public API: HtmlDirectEditSurface.

import { useEffect, useMemo } from 'react';
import { buildHtmlDirectEditDocument, escapeHtmlTextForSource } from './direct-edit/htmlSourcePatch';
import { patchSourceRange } from './direct-edit/sourcePatch';

interface Props {
  content: string;
  onContentChange: (next: string) => void;
  onSave?: (nextContent?: string) => void;
  className?: string;
}

export function HtmlDirectEditSurface({ content, onContentChange, onSave, className }: Props) {
  const document = useMemo(() => buildHtmlDirectEditDocument(content), [content]);
  const blobUrl = useMemo(() => {
    const blob = new Blob([document.html], { type: 'text/html' });
    return URL.createObjectURL(blob);
  }, [document.html]);

  useEffect(() => {
    return () => {
      try { URL.revokeObjectURL(blobUrl); } catch { /* no-op */ }
    };
  }, [blobUrl]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (!data) return;
      if (data.type === 'tower-html-direct-edit-save') {
        onSave?.();
        return;
      }
      if (data.type !== 'tower-html-direct-edit') return;
      if (!Number.isInteger(data.start) || !Number.isInteger(data.end) || typeof data.text !== 'string') return;
      try {
        const nextContent = patchSourceRange(content, data.start, data.end, escapeHtmlTextForSource(data.text));
        onContentChange(nextContent);
        if (data.save === true) onSave?.(nextContent);
      } catch {
        // The iframe will be regenerated on valid edits. Invalid source ranges
        // are ignored to avoid patching the wrong HTML.
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [content, onContentChange, onSave]);

  return (
    <div className={className ?? 'absolute inset-0'}>
      <iframe
        src={blobUrl}
        className="w-full h-full border-0 bg-white"
        sandbox="allow-scripts allow-same-origin"
        title="html-direct-edit-preview"
      />
    </div>
  );
}
