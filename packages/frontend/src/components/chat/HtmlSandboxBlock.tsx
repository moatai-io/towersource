import { useMemo, useRef, useState, useEffect } from 'react';

interface Props {
  raw: string;
  fallbackCode: string;
}

interface ParsedInput {
  html: string;
  /** Explicit fixed iframe height in px. Overrides aspect/auto. */
  height?: number;
  /** Override the default max clamp (default 600 collapsed / 1200 expanded). */
  maxHeight?: number;
  /** Width-to-height ratio. Height = containerWidth / aspect. */
  aspect?: number;
}

const DEFAULT_MAX = 600;
const EXPANDED_MAX = 1200;
const MIN_H = 100;
const BODY_MARGIN = 24; // matches the 12px body margin × 2

/**
 * Parse raw input. Supports three input shapes:
 *   1. JSON: { html: "...", height?, maxHeight?, aspect? }
 *   2. Raw SVG starting with <svg ... viewBox="..."> → aspect auto-detected
 *   3. Any other raw HTML fragment → measured by body.scrollHeight
 */
function parseInput(raw: string): ParsedInput {
  const trimmed = raw.trim();

  // JSON mode — only treat as JSON if it parses AND has an `html` string field.
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && typeof parsed.html === 'string') {
        return {
          html: parsed.html,
          height: typeof parsed.height === 'number' ? parsed.height : undefined,
          maxHeight: typeof parsed.maxHeight === 'number' ? parsed.maxHeight : undefined,
          aspect: typeof parsed.aspect === 'number' && parsed.aspect > 0 ? parsed.aspect : undefined,
        };
      }
    } catch {
      /* not JSON — fall through to raw HTML path */
    }
  }

  // Auto-detect SVG aspect-ratio from root <svg viewBox="min-x min-y w h">
  if (trimmed.startsWith('<svg')) {
    const m = trimmed.match(/<svg[^>]*\bviewBox\s*=\s*["']([^"']+)["']/i);
    if (m) {
      const parts = m[1].trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
        return { html: raw, aspect: parts[2] / parts[3] };
      }
    }
  }

  return { html: raw };
}

export default function HtmlSandboxBlock({ raw, fallbackCode: _fallbackCode }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);
  const [expanded, setExpanded] = useState(false);
  // One-shot flag: auto-expand the first time we measure content taller than
  // DEFAULT_MAX. After the user manually collapses, stay collapsed (don't fight them).
  // See: workspace/decisions/2026-04-21-html-sandbox-auto-expand.md
  const autoExpandedRef = useRef(false);

  const { html, height: fixedH, maxHeight: customMax, aspect } = useMemo(() => parseInput(raw), [raw]);

  const srcDoc = useMemo(() => {
    // Wrap in minimal HTML if no <html> tag
    if (html.trim().startsWith('<!') || html.trim().startsWith('<html')) return html;
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { margin: 12px; font-family: system-ui, sans-serif; color: #e0e0e0; background: transparent; }
  * { box-sizing: border-box; }
  svg { display: block; max-width: 100%; height: auto; }
</style></head><body>${html}</body></html>`;
  }, [html]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const maxH = customMax ?? (expanded ? EXPANDED_MAX : DEFAULT_MAX);

    const compute = () => {
      let h: number;

      if (fixedH !== undefined) {
        // Explicit height → use verbatim
        h = fixedH;
      } else if (aspect !== undefined) {
        // Aspect-ratio mode: height = width / aspect + body margin
        const w = iframe.clientWidth || 600;
        h = w / aspect + BODY_MARGIN;
      } else {
        // Measure actual content
        try {
          const body = iframe.contentDocument?.body;
          h = body ? body.scrollHeight + BODY_MARGIN : 200;
        } catch {
          return; // cross-origin, keep default
        }

        // Auto-expand once if content clearly exceeds the collapsed cap.
        // Saves users from clicking "Expand" every time an infographic or
        // animation naturally renders taller than 600px. Fires once per block;
        // manual collapse afterward is respected (ref stays true).
        if (!autoExpandedRef.current && !expanded && h > DEFAULT_MAX) {
          autoExpandedRef.current = true;
          setExpanded(true);
          return; // let the effect re-run with cap EXPANDED_MAX
        }
      }

      setHeight(Math.min(Math.max(h, MIN_H), maxH));
    };

    const handleLoad = () => compute();
    iframe.addEventListener('load', handleLoad);
    compute(); // also try immediately in case load already fired

    // Robust measurement strategy for raw HTML mode:
    // Race conditions around iframe.load are unreliable on srcDoc — load may
    // fire before useEffect attaches its listener, and compute() called
    // immediately may see body=null. The fix: observe the iframe body with
    // ResizeObserver so we get notified on every layout pass (initial render,
    // font load, image decode, dynamic content). RO fires synchronously after
    // first paint with the real content size, regardless of load timing.
    let bodyObserver: ResizeObserver | null = null;
    let pollTimer: number | null = null;

    if (fixedH === undefined && aspect === undefined && typeof ResizeObserver !== 'undefined') {
      const tryObserveBody = () => {
        try {
          const body = iframe.contentDocument?.body;
          if (body) {
            bodyObserver = new ResizeObserver(() => compute());
            bodyObserver.observe(body);
            compute();
            return true;
          }
        } catch { /* cross-origin or doc not ready */ }
        return false;
      };

      // Try now; if body not ready yet, poll briefly until it is.
      if (!tryObserveBody()) {
        let attempts = 0;
        const tick = () => {
          attempts++;
          if (tryObserveBody() || attempts > 20) return;
          pollTimer = window.setTimeout(tick, 50);
        };
        pollTimer = window.setTimeout(tick, 50);
      }
    }

    // Width changes (aspect mode only) re-trigger ratio-based sizing.
    const widthObserver = aspect !== undefined && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => compute())
      : null;
    if (widthObserver) widthObserver.observe(iframe);

    return () => {
      iframe.removeEventListener('load', handleLoad);
      bodyObserver?.disconnect();
      widthObserver?.disconnect();
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [expanded, fixedH, customMax, aspect]);

  return (
    <div className="my-3 rounded-lg border border-surface-700/40 bg-surface-900/40 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-800/40 border-b border-surface-700/30">
        <span className="text-[12px] uppercase tracking-wider text-gray-500 font-medium">HTML Sandbox</span>
        <div className="flex gap-1">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[12px] px-2 py-0.5 rounded bg-surface-700/40 hover:bg-surface-700/60 text-gray-400 hover:text-gray-200 transition-colors"
          >
            {expanded ? 'Collapse' : 'Expand'}
          </button>
          <button
            onClick={() => {
              const w = window.open('', '_blank');
              if (w) { w.document.write(srcDoc); w.document.close(); }
            }}
            className="text-[12px] px-2 py-0.5 rounded bg-surface-700/40 hover:bg-surface-700/60 text-gray-400 hover:text-gray-200 transition-colors"
          >
            Open
          </button>
        </div>
      </div>
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        // allow-same-origin is REQUIRED for the parent to read
        // iframe.contentDocument.body and run ResizeObserver on it.
        // Without it, the iframe is in a unique origin → cross-origin
        // SecurityError on every measurement attempt → height stuck at 200.
        // We accept the tradeoff (sandboxed scripts can read parent
        // localStorage/cookies) because html-sandbox content is AI-generated
        // by our own system, not arbitrary user input.
        sandbox="allow-scripts allow-same-origin"
        style={{ width: '100%', height, border: 'none', background: 'transparent' }}
        title="HTML Sandbox"
      />
    </div>
  );
}
