import React, { Suspense, useMemo, type CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import { isChunkLoadError, recoverFromChunkLoadError } from '../../utils/app-version';
import { remarkGfmPlugin } from '../../utils/markdown-plugins';

const MermaidBlock = React.lazy(async () => {
  try {
    const module = await import('../chat/MermaidBlock');
    return { default: module.MermaidBlock };
  } catch (error) {
    // An old open tab can request a removed hashed chunk after deploy and receive
    // the SPA's index.html fallback. Reload once with cleared JS caches instead of
    // leaving raw Mermaid source under a browser MIME error.
    if (isChunkLoadError(error)) recoverFromChunkLoadError();
    throw error;
  }
});

function stripFrontmatterForPreview(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match || !/^[A-Za-z0-9_-]+:\s*/m.test(match[1])) return content;
  return content.slice(match[0].length);
}

interface MarkdownReadSurfaceProps {
  content: string;
  components: any;
  className?: string;
  style?: CSSProperties;
  containerRef?: React.Ref<HTMLDivElement>;
}

export function MarkdownReadContent({ content, components }: Pick<MarkdownReadSurfaceProps, 'content' | 'components'>) {
  const previewContent = useMemo(() => stripFrontmatterForPreview(content), [content]);
  const segments = useMemo(() => {
    const result: { type: 'md' | 'mermaid'; text: string }[] = [];
    const regex = /```mermaid\s*\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(previewContent)) !== null) {
      if (match.index > lastIndex) result.push({ type: 'md', text: previewContent.slice(lastIndex, match.index) });
      result.push({ type: 'mermaid', text: match[1].trimEnd() });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < previewContent.length) result.push({ type: 'md', text: previewContent.slice(lastIndex) });
    return result;
  }, [previewContent]);

  return (
    <>
      {segments.map((segment, index) => segment.type === 'mermaid' ? (
        <Suspense key={index} fallback={<pre><code>{segment.text}</code></pre>}>
          <MermaidBlock code={segment.text} />
        </Suspense>
      ) : (
        <ReactMarkdown
          key={index}
          remarkPlugins={[remarkGfmPlugin]}
          rehypePlugins={[rehypeSlug, rehypeRaw, rehypeHighlight]}
          components={components}
        >
          {segment.text}
        </ReactMarkdown>
      ))}
    </>
  );
}

export function MarkdownReadSurface({ content, components, className, style, containerRef }: MarkdownReadSurfaceProps) {
  return (
    <div ref={containerRef} className={className ?? 'prose prose-invert prose-sm max-w-none p-4'} style={style}>
      <MarkdownReadContent content={content} components={components} />
    </div>
  );
}
