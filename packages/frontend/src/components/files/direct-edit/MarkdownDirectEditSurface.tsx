// Owns: source-backed cursor editing for Markdown preview. Public API: MarkdownDirectEditSurface.
// See README.md and docs/plans/2026-06-04-preview-direct-edit.md.

import React, { useMemo, useRef, type CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import { MermaidBlock } from '../../chat/MermaidBlock';
import { remarkGfmPlugin } from '../../../utils/markdown-plugins';
import { containsInlineMarkdownSyntax, locateTextInSource, normalizeEditableText, patchSourceRange } from './sourcePatch';

function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return extractText(node.props.children);
  return '';
}

type Segment = { type: 'md' | 'mermaid'; text: string; sourceStart: number };

function stripFrontmatterForPreview(content: string): { text: string; offset: number } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  // Keep source offsets aligned with the original file after hiding frontmatter in preview.
  if (!match || !/^[A-Za-z0-9_-]+:\s*/m.test(match[1])) return { text: content, offset: 0 };
  return { text: content.slice(match[0].length), offset: match[0].length };
}

function splitMermaidSegments(content: string): Segment[] {
  const preview = stripFrontmatterForPreview(content);
  const text = preview.text;
  const result: Segment[] = [];
  const regex = /```mermaid\s*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push({ type: 'md', text: text.slice(lastIndex, match.index), sourceStart: preview.offset + lastIndex });
    }
    result.push({ type: 'mermaid', text: match[1].trimEnd(), sourceStart: preview.offset + match.index });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) result.push({ type: 'md', text: text.slice(lastIndex), sourceStart: preview.offset + lastIndex });
  return result;
}

type EditableTag = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'li' | 'td' | 'th';
type PatchMode = 'exact-text' | 'block-inner';
type PatchRange = { start: number; end: number; mode: PatchMode };

function offsetFromNode(node: any, sourceStart: number): { start: number; end: number } | null {
  const start = node?.position?.start?.offset;
  const end = node?.position?.end?.offset;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
  return { start: sourceStart + start, end: sourceStart + end };
}

function locateTextInsideRange(content: string, range: { start: number; end: number }, text: string): PatchRange | null {
  const blockSource = content.slice(range.start, range.end);
  const located = locateTextInSource({ source: blockSource, text });
  if ('start' in located) {
    return { start: range.start + located.start, end: range.start + located.end, mode: 'exact-text' };
  }
  return null;
}

function blockInnerRange(content: string, tag: EditableTag, block: { start: number; end: number }): PatchRange | null {
  const raw = content.slice(block.start, block.end);
  if (containsInlineMarkdownSyntax(raw)) return null;

  // Headings: keep the leading # marker and following spaces.
  if (tag.startsWith('h')) {
    const m = raw.match(/^(#{1,6}\s+)/);
    if (!m) return null;
    return { start: block.start + m[1].length, end: block.end, mode: 'block-inner' };
  }

  // List items: keep indentation + bullet/number marker + task checkbox.
  // This is the case the user hit: rendered text with inline code/bold did not
  // match raw source because of Markdown markers. Fallback patches the list
  // item's textual payload while preserving the list indentation/marker.
  if (tag === 'li') {
    const m = raw.match(/^(\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/);
    if (!m) return null;
    return { start: block.start + m[1].length, end: block.end, mode: 'block-inner' };
  }

  // Paragraphs/table cells: if exact text failed, replacing the whole block is
  // safer than patching the wrong repeated text elsewhere. For table cells this
  // is conservative but useful for simple cells.
  if (tag === 'p' || tag === 'td' || tag === 'th') {
    return { start: block.start, end: block.end, mode: 'block-inner' };
  }

  return null;
}

function createEditableBlock(tag: EditableTag, content: string, sourceStart: number, onContentChange: (next: string) => void) {
  return function EditableMarkdownBlock({ children, className, node, ...props }: any) {
    const elRef = useRef<HTMLElement | null>(null);
    const originalTextRef = useRef('');
    const originalHtmlRef = useRef('');
    const originalRangeRef = useRef<PatchRange | null>(null);

    const text = normalizeEditableText(extractText(children));
    const nodeRange = offsetFromNode(node, sourceStart);
    const exactRange = nodeRange ? locateTextInsideRange(content, nodeRange, text) : null;
    const fallbackRange = nodeRange ? blockInnerRange(content, tag, nodeRange) : null;
    const initialRange = exactRange ?? fallbackRange;
    const editable = text.trim().length > 0 && !!initialRange;

    const cls = [
      className,
      editable ? 'tower-direct-edit-editable cursor-text rounded-sm outline-offset-2 hover:outline hover:outline-1 hover:outline-surface-500/30 focus:outline focus:outline-1 focus:outline-primary-400/70' : '',
    ].filter(Boolean).join(' ');

    const handleFocus = (e: React.FocusEvent<HTMLElement>) => {
      originalTextRef.current = normalizeEditableText(e.currentTarget.innerText);
      originalHtmlRef.current = e.currentTarget.innerHTML;
      originalRangeRef.current = initialRange;
    };

    const handleBlur = (e: React.FocusEvent<HTMLElement>) => {
      const originalText = originalTextRef.current;
      const nextText = normalizeEditableText(e.currentTarget.innerText);
      if (!editable || !originalText || nextText === originalText) return;

      const range = originalRangeRef.current;
      if (!range) {
        e.currentTarget.innerHTML = originalHtmlRef.current;
        return;
      }

      try {
        onContentChange(patchSourceRange(content, range.start, range.end, nextText));
      } catch {
        e.currentTarget.innerHTML = originalHtmlRef.current;
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (elRef.current) {
          elRef.current.innerHTML = originalHtmlRef.current;
          elRef.current.blur();
        }
        return;
      }

      if (e.key === 'Enter' && tag !== 'p' && tag !== 'li' && tag !== 'td' && tag !== 'th') {
        e.preventDefault();
        elRef.current?.blur();
      }
    };

    return React.createElement(
      tag,
      {
        ...props,
        ref: elRef,
        className: cls || undefined,
        contentEditable: editable ? 'plaintext-only' : undefined,
        suppressContentEditableWarning: editable || undefined,
        title: editable ? '클릭해서 바로 수정' : undefined,
        onFocus: editable ? handleFocus : undefined,
        onBlur: editable ? handleBlur : undefined,
        onKeyDown: editable ? handleKeyDown : undefined,
      },
      children,
    );
  };
}

function MarkdownSegmentRenderer({
  segment,
  components,
  content,
  onContentChange,
}: {
  segment: Segment;
  components: any;
  content: string;
  onContentChange: (next: string) => void;
}) {
  const directComponents = useMemo(() => {
    const wrap = (tag: EditableTag) => createEditableBlock(tag, content, segment.sourceStart, onContentChange);
    return {
      ...components,
      p: wrap('p'),
      h1: wrap('h1'),
      h2: wrap('h2'),
      h3: wrap('h3'),
      h4: wrap('h4'),
      h5: wrap('h5'),
      h6: wrap('h6'),
      li: wrap('li'),
      td: wrap('td'),
      th: wrap('th'),
    };
  }, [components, content, onContentChange, segment.sourceStart]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfmPlugin]}
      rehypePlugins={[rehypeSlug, rehypeRaw, rehypeHighlight]}
      components={directComponents}
    >
      {segment.text}
    </ReactMarkdown>
  );
}

interface Props {
  content: string;
  components: any;
  onContentChange: (next: string) => void;
  className?: string;
  style?: CSSProperties;
}

export function MarkdownDirectEditSurface({ content, components, onContentChange, className, style }: Props) {
  const segments = useMemo(() => splitMermaidSegments(content), [content]);

  return (
    <div className={className ?? 'prose prose-invert prose-sm max-w-none p-4'} style={style}>
      {segments.map((seg, i) =>
        seg.type === 'mermaid' ? (
          <MermaidBlock key={i} code={seg.text} />
        ) : (
          <MarkdownSegmentRenderer
            key={i}
            segment={seg}
            components={components}
            content={content}
            onContentChange={onContentChange}
          />
        ),
      )}
    </div>
  );
}
