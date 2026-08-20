import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { MarkdownPreviewSurface } from '../files/MarkdownPreviewSurface';

const CODE_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'py', 'sh', 'bash', 'sql', 'json', 'yaml', 'yml', 'css', 'xml', 'toml', 'ini', 'env', 'log', 'txt']);
const MARKDOWN_EXTS = new Set(['md', 'markdown']);
const PREVIEWABLE_EXTS = new Set([...MARKDOWN_EXTS, ...CODE_EXTS, 'html', 'htm', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'webm']);
// 브라우저가 직접 렌더링하는 파일 — iframe으로 표시.
// PDF is intentionally excluded: open it as a top-level browser PDF viewer instead.
const IFRAME_EXTS = new Set(['html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'webm']);

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  sql: 'sql',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  css: 'css',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  toml: 'toml',
  ini: 'ini',
  env: 'ini',
  log: 'plaintext',
  txt: 'plaintext',
};

interface FileData {
  content: string;
  fileName: string;
  ext: string;
  encoding?: string;
}

function prettyContent(content: string, ext: string): string {
  if (ext !== 'json') return content;
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function fencedCode(content: string, language: string): string {
  const longestBacktickRun = Math.max(2, ...Array.from(content.matchAll(/`+/g), match => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}

function MarkdownPreview({ content, token, fileName }: { content: string; token: string; fileName: string }) {
  const components = useMemo(() => ({
    img({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
      if (!src) return null;
      if (/^https?:\/\//.test(src)) return <img src={src} alt={alt} {...props} style={{ maxWidth: '100%' }} />;
      // Shared documents intentionally do not expose the original workspace path.
      // Relative asset resolution needs a separate tokenized asset endpoint before
      // it can be safely enabled here.
      return <img src={src} alt={alt} {...props} style={{ maxWidth: '100%' }} />;
    },
  }), []);

  return (
    <div className="mx-auto w-full max-w-[920px] px-6 py-8 sm:px-8 lg:px-12">
      <MarkdownPreviewSurface
        content={content}
        filePath={`shared:${token}/${fileName}`}
        components={components}
        onContentChange={() => {}}
        inlineEditEnabled={false}
        previewDirectEditEnabled={false}
        inlineEditDisabled={true}
        className="prose prose-invert prose-sm max-w-none markdown-document"
      />
    </div>
  );
}

function CodePreview({ content, ext, encoding }: { content: string; ext: string; encoding?: string }) {
  const { t } = useTranslation('share');
  const language = LANGUAGE_BY_EXT[ext] || ext || 'plaintext';
  const pretty = useMemo(() => prettyContent(content, ext), [content, ext]);
  const markdown = useMemo(() => fencedCode(pretty, language), [pretty, language]);

  return (
    <div className="shared-code-preview rounded-2xl border border-gray-800 bg-gray-950 shadow-2xl shadow-black/20 overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-gray-800 bg-gray-900/70 px-4 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
          <span className="h-2.5 w-2.5 rounded-full tone-warning tone-bg opacity-80" />
          <span className="h-2.5 w-2.5 rounded-full tone-success tone-bg opacity-80" />
          <span className="ml-2 truncate text-sm text-gray-400">{t('codePreview')}</span>
        </div>
        <div className="flex items-center gap-2 text-[13px] text-gray-500">
          <span className="rounded-md border border-gray-700 bg-gray-900 px-2 py-0.5 uppercase tracking-wide text-gray-400">{language}</span>
          {encoding && <span>{encoding}</span>}
        </div>
      </div>
      <div className="shared-code-body prose prose-invert prose-sm max-w-none">
        <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
          {markdown}
        </ReactMarkdown>
      </div>
    </div>
  );
}

export function SharedViewer() {
  const { t } = useTranslation('share');
  const token = window.location.pathname.split('/shared/')[1];
  const [data, setData] = useState<FileData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview');

  useEffect(() => {
    if (!token) { setError(t('invalidLink')); setLoading(false); return; }
    fetch(`/api/shared/${token}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(setData)
      .catch(() => setError(t('expiredOrRevoked')))
      .finally(() => setLoading(false));
  }, [t, token]);

  const handleDownload = () => {
    window.location.href = `/api/shared/${token}?download=1`;
  };

  if (loading) {
    return (
      <div className="bg-gray-950 flex items-center justify-center" style={{ height: '100dvh' }}>
        <div className="text-gray-400 text-base">{t('loading')}</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-gray-950 flex items-center justify-center" style={{ height: '100dvh' }}>
        <div className="text-center space-y-3">
          <div className="text-6xl">🔗</div>
          <p className="text-gray-300 text-base">{error || t('loadFailed')}</p>
        </div>
      </div>
    );
  }

  const canPreview = PREVIEWABLE_EXTS.has(data.ext);
  const isPdf = data.ext === 'pdf';
  const useIframe = IFRAME_EXTS.has(data.ext);
  const isMarkdown = MARKDOWN_EXTS.has(data.ext);
  const isCode = CODE_EXTS.has(data.ext);
  const renderUrl = `/api/shared/${token}?render=1`;
  const rawAvailable = !isPdf && (data.content.length > 0 || !useIframe);
  const fullBleedPreview = (useIframe || isPdf) && viewMode === 'preview';

  return (
    <div className="flex flex-col bg-gray-950 text-gray-100" style={{ height: '100dvh' }}>
      {/* Header */}
      <div className="shrink-0 border-b border-gray-800 px-6 py-3 flex items-center justify-between bg-gray-950/90 backdrop-blur">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <svg className="w-4 h-4 shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
            <span className="truncate text-base font-medium text-white">{data.fileName}</span>
          </div>
          {/* Preview / Raw 탭 — previewable 파일에만 표시 */}
          {canPreview && (
            <div className="flex shrink-0 items-center bg-gray-900 rounded-lg p-0.5 border border-gray-800">
              <button
                onClick={() => setViewMode('preview')}
                className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                  viewMode === 'preview'
                    ? 'bg-gray-700 text-white'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {t('preview')}
              </button>
              {rawAvailable && (
                <button
                  onClick={() => setViewMode('raw')}
                  className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                    viewMode === 'raw'
                      ? 'bg-gray-700 text-white'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {t('raw')}
                </button>
              )}
            </div>
          )}
        </div>
        <button
          onClick={handleDownload}
          className="flex shrink-0 items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          {t('download')}
        </button>
      </div>

      {/* Content — flex-1 + overflow-y-auto so body scroll is not needed */}
      <div className={`flex-1 overflow-y-auto ${fullBleedPreview ? '' : 'shared-viewer-page mx-auto w-full px-6 py-8'}`}>
        {viewMode === 'raw' ? (
          /* 원본 — 항상 plain text */
          <pre className="text-base text-gray-300 whitespace-pre-wrap leading-relaxed font-mono">{data.content}</pre>
        ) : isPdf ? (
          /* PDF — iframe 대신 브라우저 최상위 PDF viewer로 직접 열기 */
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <svg className="w-16 h-16 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
            <p className="max-w-md break-words text-base text-gray-300">{data.fileName}</p>
            <p className="max-w-md text-sm leading-6 text-gray-500">{t('pdfViewerHint')}</p>
            <a
              href={renderUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-base rounded-lg transition-colors"
            >
              {t('openInNewTab')}
            </a>
          </div>
        ) : useIframe ? (
          /* 미리보기 — PDF / HTML / 이미지 / 영상: 브라우저 네이티브 렌더링 */
          <iframe
            src={renderUrl}
            className="w-full h-full border-0"
            title={data.fileName}
            sandbox="allow-scripts allow-same-origin allow-popups"
            referrerPolicy="no-referrer"
          />
        ) : isMarkdown ? (
          /* 미리보기 — 마크다운 렌더링: 내부 /file-viewer 와 같은 MarkdownPreviewSurface 재사용 */
          <MarkdownPreview content={data.content} token={token} fileName={data.fileName} />
        ) : isCode ? (
          /* 미리보기 — 코드 syntax highlight + JSON pretty print */
          <CodePreview content={data.content} ext={data.ext} encoding={data.encoding} />
        ) : (
          /* 미리보기 — 일반 텍스트 */
          <pre className="text-base text-gray-300 whitespace-pre-wrap leading-relaxed">{data.content}</pre>
        )}
      </div>
    </div>
  );
}
