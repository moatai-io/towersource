// Owns: conservative source-backed text editing for HTML preview.
// Public API: buildHtmlDirectEditDocument, escapeHtmlTextForSource.

const EXCLUDED_TEXT_ANCESTORS = new Set([
  'script',
  'style',
  'svg',
  'canvas',
  'noscript',
  'template',
  'textarea',
  'select',
  'option',
  'head',
]);

export interface HtmlDirectEditRange {
  id: string;
  start: number;
  end: number;
}

export interface HtmlDirectEditDocument {
  html: string;
  ranges: HtmlDirectEditRange[];
}

export function escapeHtmlTextForSource(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function findTagEnd(source: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return source.length - 1;
}

function parseTag(rawTag: string): { name: string; closing: boolean; selfClosing: boolean } | null {
  if (!rawTag.startsWith('<') || rawTag.startsWith('<!--') || rawTag.startsWith('<!') || rawTag.startsWith('<?')) {
    return null;
  }
  const closing = /^<\s*\//.test(rawTag);
  const match = rawTag.match(/^<\s*\/?\s*([a-zA-Z][\w:-]*)/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const selfClosing = /\/\s*>$/.test(rawTag) || new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]).has(name);
  return { name, closing, selfClosing };
}

function hasExcludedAncestor(stack: string[]): boolean {
  return stack.some((name) => EXCLUDED_TEXT_ANCESTORS.has(name));
}

function shouldWrapText(text: string, stack: string[]): boolean {
  return text.trim().length > 0 && !hasExcludedAncestor(stack);
}

function directEditStyle(): string {
  return `<style id="tower-html-direct-edit-style">
.tower-html-direct-edit-text {
  cursor: text;
  border-radius: 2px;
  outline-offset: 2px;
}
.tower-html-direct-edit-text:hover {
  outline: 1px solid rgba(96, 165, 250, 0.35);
}
.tower-html-direct-edit-text:focus {
  outline: 1px solid rgba(96, 165, 250, 0.85);
}
</style>`;
}

function directEditScript(): string {
  return `<script id="tower-html-direct-edit-script">
(() => {
  const normalize = (value) => value.replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').replace(/\n$/g, '');
  document.addEventListener('focusin', (event) => {
    const el = event.target.closest?.('[data-tower-edit-id]');
    if (!el) return;
    el.dataset.towerOriginalText = normalize(el.innerText || '');
    el.dataset.towerOriginalHtml = el.innerHTML;
  });
  document.addEventListener('focusout', (event) => {
    const el = event.target.closest?.('[data-tower-edit-id]');
    if (!el) return;
    if (el.dataset.towerSkipFocusout === '1') {
      delete el.dataset.towerSkipFocusout;
      return;
    }
    const original = el.dataset.towerOriginalText || '';
    const next = normalize(el.innerText || '');
    if (!original || next === original) return;
    window.parent.postMessage({
      type: 'tower-html-direct-edit',
      id: el.dataset.towerEditId,
      start: Number(el.dataset.sourceStart),
      end: Number(el.dataset.sourceEnd),
      text: next,
    }, '*');
  });
  document.addEventListener('keydown', (event) => {
    const el = event.target.closest?.('[data-tower-edit-id]');
    if (!el) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      const original = el.dataset.towerOriginalText || '';
      const next = normalize(el.innerText || '');
      if (original && next !== original) {
        el.dataset.towerSkipFocusout = '1';
        window.parent.postMessage({
          type: 'tower-html-direct-edit',
          id: el.dataset.towerEditId,
          start: Number(el.dataset.sourceStart),
          end: Number(el.dataset.sourceEnd),
          text: next,
          save: true,
        }, '*');
      } else {
        window.parent.postMessage({ type: 'tower-html-direct-edit-save' }, '*');
      }
      el.blur();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      el.innerHTML = el.dataset.towerOriginalHtml || el.innerHTML;
      el.blur();
    }
  });
})();
</script>`;
}

function injectHeadAssets(html: string): string {
  const assets = `${directEditStyle()}${directEditScript()}`;
  const headClose = html.search(/<\/head\s*>/i);
  if (headClose >= 0) return html.slice(0, headClose) + assets + html.slice(headClose);
  const bodyOpen = html.search(/<body\b[^>]*>/i);
  if (bodyOpen >= 0) {
    const end = findTagEnd(html, bodyOpen);
    return html.slice(0, end + 1) + assets + html.slice(end + 1);
  }
  return assets + html;
}

/**
 * Wrap visible HTML text nodes with small editable spans while keeping source
 * offsets pointed at the original unmodified HTML string.
 *
 * This intentionally does not rebuild the DOM from browser innerHTML. It only
 * inserts markers into a preview copy and patches exact source ranges later.
 */
export function buildHtmlDirectEditDocument(source: string): HtmlDirectEditDocument {
  const ranges: HtmlDirectEditRange[] = [];
  const stack: string[] = [];
  let out = '';
  let i = 0;
  let seq = 0;

  while (i < source.length) {
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      const next = end >= 0 ? end + 3 : source.length;
      out += source.slice(i, next);
      i = next;
      continue;
    }

    if (source[i] === '<') {
      const end = findTagEnd(source, i);
      const rawTag = source.slice(i, end + 1);
      const parsed = parseTag(rawTag);
      if (parsed) {
        if (parsed.closing) {
          const idx = stack.lastIndexOf(parsed.name);
          if (idx >= 0) stack.splice(idx);
        }
        out += rawTag;
        if (!parsed.closing && !parsed.selfClosing) stack.push(parsed.name);
      } else {
        out += rawTag;
      }
      i = end + 1;
      continue;
    }

    const nextTag = source.indexOf('<', i);
    const end = nextTag >= 0 ? nextTag : source.length;
    const text = source.slice(i, end);
    if (shouldWrapText(text, stack)) {
      const id = `html-text-${seq++}`;
      ranges.push({ id, start: i, end });
      out += `<span class="tower-html-direct-edit-text" contenteditable="plaintext-only" data-tower-edit-id="${id}" data-source-start="${i}" data-source-end="${end}" title="클릭해서 바로 수정">${text}</span>`;
    } else {
      out += text;
    }
    i = end;
  }

  return { html: injectHeadAssets(out), ranges };
}
