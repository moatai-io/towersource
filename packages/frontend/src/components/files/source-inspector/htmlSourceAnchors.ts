// Owns: source-backed element anchors for static HTML previews.
// Public API: buildHtmlSourceInspectorDocument and its source anchor types.

import { parse, type DefaultTreeAdapterMap } from 'parse5';

// Keep selectable element source within the isolated inline-edit engine's hard
// cap. Larger containers remain navigable through their smaller descendants.
const MAX_ANCHOR_SOURCE_LENGTH = 4_000;

const EXCLUDED_ELEMENT_NAMES = new Set([
  'html',
  'head',
  'body',
  'script',
  'style',
  'template',
  'link',
  'meta',
  'base',
  'title',
  'noscript',
]);

export interface HtmlSourceAnchor {
  id: string;
  tagName: string;
  start: number;
  end: number;
  lineStart: number;
  lineEnd: number;
  source: string;
}

export interface HtmlSourceInspectorDocument {
  html: string;
  anchors: HtmlSourceAnchor[];
  nonce: string;
}

type DocumentNode = DefaultTreeAdapterMap['document'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type ChildNode = DefaultTreeAdapterMap['childNode'];
type ElementNode = DefaultTreeAdapterMap['element'];
type SourceLocation = NonNullable<ElementNode['sourceCodeLocation']>;

function isElement(node: ChildNode): node is ElementNode {
  return 'tagName' in node && typeof node.tagName === 'string';
}

function hasUsableLocation(location: ElementNode['sourceCodeLocation']): location is SourceLocation {
  return Boolean(
    location
    && Number.isInteger(location.startOffset)
    && Number.isInteger(location.endOffset)
    && location.endOffset > location.startOffset,
  );
}

function collectElements(node: DocumentNode | ParentNode, output: ElementNode[]) {
  for (const child of node.childNodes) {
    if (!isElement(child)) continue;
    output.push(child);
    collectElements(child, output);
    if ('content' in child && child.content) collectElements(child.content, output);
  }
}

function inspectorStyle(): string {
  return `<style id="tower-source-inspector-style">
html[data-tower-source-inspector="on"],
html[data-tower-source-inspector="on"] * {
  cursor: crosshair !important;
}
#tower-source-inspector-overlay {
  position: fixed;
  display: none;
  pointer-events: none;
  z-index: 2147483646;
  border: 2px solid rgba(59, 130, 246, 0.95);
  background: rgba(59, 130, 246, 0.10);
  border-radius: 4px;
  box-sizing: border-box;
}
#tower-source-inspector-label {
  position: fixed;
  display: none;
  pointer-events: none;
  z-index: 2147483647;
  max-width: min(520px, calc(100vw - 16px));
  padding: 5px 8px;
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.96);
  color: #e2e8f0;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  font: 600 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>`;
}

function inspectorScript(nonce: string): string {
  const safeNonce = JSON.stringify(nonce);
  return `<script id="tower-source-inspector-script">
(() => {
  const nonce = ${safeNonce};
  const root = document.documentElement;
  const overlay = document.createElement('div');
  const label = document.createElement('div');
  overlay.id = 'tower-source-inspector-overlay';
  label.id = 'tower-source-inspector-label';
  document.addEventListener('DOMContentLoaded', () => {
    document.body.append(overlay, label);
  }, { once: true });

  let enabled = false;
  let hovered = null;

  const send = (type, detail = {}) => {
    window.parent.postMessage({ type, nonce, ...detail }, '*');
  };

  const hide = () => {
    overlay.style.display = 'none';
    label.style.display = 'none';
    hovered = null;
  };

  const anchorFor = (target) => target instanceof Element
    ? target.closest('[data-tower-source-anchor]')
    : null;

  const render = (element) => {
    if (!(element instanceof Element)) return hide();
    const rects = Array.from(element.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) return hide();
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    overlay.style.display = 'block';
    overlay.style.left = left + 'px';
    overlay.style.top = top + 'px';
    overlay.style.width = Math.max(0, right - left) + 'px';
    overlay.style.height = Math.max(0, bottom - top) + 'px';
    label.style.display = 'block';
    label.style.left = Math.max(8, Math.min(left, window.innerWidth - 220)) + 'px';
    label.style.top = Math.max(8, top - 30) + 'px';
    const lineStart = element.dataset.towerSourceLineStart;
    const lineEnd = element.dataset.towerSourceLineEnd;
    const range = lineStart && lineEnd ? ' · L' + lineStart + '–L' + lineEnd : '';
    label.textContent = '<' + element.tagName.toLowerCase() + '>' + range + ' · exact source';
    hovered = element;
    send('tower-html-source-hover', { anchorId: element.dataset.towerSourceAnchor });
  };

  document.addEventListener('pointermove', (event) => {
    if (!enabled) return;
    const anchor = anchorFor(event.target);
    if (anchor === hovered) return;
    if (anchor) render(anchor);
    else hide();
  }, true);

  document.addEventListener('pointerleave', () => {
    if (enabled) hide();
  }, true);

  document.addEventListener('click', (event) => {
    if (!enabled) return;
    const anchor = anchorFor(event.target);
    if (!anchor) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    render(anchor);
    send('tower-html-source-select', { anchorId: anchor.dataset.towerSourceAnchor });
  }, true);

  document.addEventListener('keydown', (event) => {
    if (!enabled || event.key !== 'Escape') return;
    event.preventDefault();
    send('tower-html-source-exit');
  }, true);

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window.parent || !data || data.nonce !== nonce) return;
    if (data.type === 'tower-html-source-inspector-enable') {
      enabled = true;
      root.dataset.towerSourceInspector = 'on';
    } else if (data.type === 'tower-html-source-inspector-disable') {
      enabled = false;
      delete root.dataset.towerSourceInspector;
      hide();
    }
  });

  send('tower-html-source-ready');
})();
</script>`;
}

function sourceAttributeInsertionOffset(source: string, location: SourceLocation): number {
  const tagEnd = location.startTag?.endOffset;
  if (!tagEnd) return location.startOffset;
  let offset = tagEnd - 1;
  while (offset > location.startOffset && /\s/.test(source[offset - 1])) offset -= 1;
  if (source[offset - 1] === '/') {
    offset -= 1;
    while (offset > location.startOffset && /\s/.test(source[offset - 1])) offset -= 1;
  }
  return offset;
}

function injectBeforeClosingTag(html: string, closingTag: RegExp, assets: string): string | null {
  const match = closingTag.exec(html);
  if (!match || match.index < 0) return null;
  return html.slice(0, match.index) + assets + html.slice(match.index);
}

function injectAssets(html: string, assets: string): string {
  return injectBeforeClosingTag(html, /<\/head\s*>/i, assets)
    ?? injectBeforeClosingTag(html, /<\/body\s*>/i, assets)
    ?? `${assets}${html}`;
}

/**
 * Instrument a preview-only copy of static HTML with opaque source anchor IDs.
 * Every offset remains relative to the original, unmodified source string.
 */
export function buildHtmlSourceInspectorDocument(source: string, nonce: string): HtmlSourceInspectorDocument {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const elements: ElementNode[] = [];
  collectElements(document, elements);

  const anchors: HtmlSourceAnchor[] = [];
  const insertions: Array<{ offset: number; value: string }> = [];

  for (const element of elements) {
    const location = element.sourceCodeLocation;
    if (EXCLUDED_ELEMENT_NAMES.has(element.tagName) || !hasUsableLocation(location) || !location.startTag) continue;
    if (location.endOffset - location.startOffset > MAX_ANCHOR_SOURCE_LENGTH) continue;

    const id = `html-element-${anchors.length}`;
    anchors.push({
      id,
      tagName: element.tagName,
      start: location.startOffset,
      end: location.endOffset,
      lineStart: location.startLine,
      lineEnd: location.endLine,
      source: source.slice(location.startOffset, location.endOffset),
    });
    insertions.push({
      offset: sourceAttributeInsertionOffset(source, location),
      value: ` data-tower-source-anchor="${id}" data-tower-source-line-start="${location.startLine}" data-tower-source-line-end="${location.endLine}"`,
    });
  }

  let instrumented = source;
  for (const insertion of insertions.sort((a, b) => b.offset - a.offset)) {
    instrumented = instrumented.slice(0, insertion.offset) + insertion.value + instrumented.slice(insertion.offset);
  }

  const assets = `${inspectorStyle()}${inspectorScript(nonce)}`;
  return { html: injectAssets(instrumented, assets), anchors, nonce };
}
