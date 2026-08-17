import { useMemo } from 'react';
import DOMPurify, { type Config } from 'dompurify';
import { useTranslation } from 'react-i18next';

interface Props {
  raw: string;
  fallbackCode: string;
}

/**
 * Inline SVG renderer — sanitizes via DOMPurify (SVG + SVG filters profile)
 * then injects into the host document (no iframe).
 *
 * Security:
 *   - USE_PROFILES.svg / svgFilters whitelists safe SVG elements/attrs
 *     (allows <animate>, <animateTransform>, <animateMotion>, filters)
 *   - Explicitly forbids <foreignObject> (can host arbitrary HTML)
 *   - on* event handlers are stripped by the profile
 *   - <script> is stripped by the profile
 *
 * Performance:
 *   - No iframe overhead (~1-2MB saved per SVG vs html-sandbox)
 *   - Renders in main document — same compositor, no extra context
 *   - Natural size; constrained by parent width via CSS max-width: 100%
 */

/**
 * Security model for SVG animations:
 *
 * DOMPurify's default SVG profile STRIPS <animate> and <set> because SMIL
 * animation on <a href>/<use href>/<... attributeName="href"> can be used
 * for clickjacking-style XSS (animated href → javascript: URL).
 *
 * Our svg-animation skill relies heavily on <animate> for fade-in sequences,
 * so we re-enable it with mitigations:
 *
 *   1. FORBID <a>  — removes the primary clickable XSS vector
 *   2. ADD_TAGS: ['animate', 'set'] — re-enable animation primitives
 *   3. Install a hook that rejects any <animate>/<set> whose `attributeName`
 *      targets a URL-bearing attr (href/xlink:href/src/action/formaction).
 *      This neutralizes the remaining SMIL XSS paths.
 */

const DANGEROUS_ANIM_TARGETS = new Set([
  'href', 'xlink:href', 'src', 'action', 'formaction',
  // Also block animating attributes that can smuggle URL schemes
  'style',
]);

// Install the hook exactly once (module scope).
let hookInstalled = false;
function installAnimSafetyHook() {
  if (hookInstalled) return;
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    const tag = node.nodeName?.toLowerCase();
    if ((tag === 'animate' || tag === 'set' || tag === 'animatetransform' || tag === 'animatemotion')
        && data.attrName === 'attributename') {
      const target = String(data.attrValue || '').toLowerCase();
      if (DANGEROUS_ANIM_TARGETS.has(target)) {
        // Reject the whole element by dropping the attrName — downstream, the
        // animation cannot fire without attributeName, so it's neutralized.
        data.keepAttr = false;
      }
    }
  });
  hookInstalled = true;
}

installAnimSafetyHook();

const SANITIZE_CONFIG: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  // Re-enable animation primitives stripped by default profile
  ADD_TAGS: ['animate', 'set'],
  // Lock down XSS vectors
  FORBID_TAGS: ['foreignObject', 'script', 'a'],
  FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onmouseout', 'onfocus', 'onblur'],
  KEEP_CONTENT: true,
};

function sanitizeSvg(raw: string): { ok: true; html: string } | { ok: false; error: string } {
  const trimmed = raw.trim();

  // Strip XML prolog / doctype if present — DOMPurify handles but keep input clean
  const withoutProlog = trimmed
    .replace(/^<\?xml[^?]*\?>\s*/i, '')
    .replace(/^<!DOCTYPE[^>]*>\s*/i, '');

  if (!withoutProlog.startsWith('<svg')) {
    return { ok: false, error: 'Content must start with <svg>' };
  }

  try {
    // Explicit overload: no RETURN_DOM* flags → returns string
    const cleaned: string = DOMPurify.sanitize(withoutProlog, SANITIZE_CONFIG);
    if (!cleaned || !cleaned.trim()) {
      return { ok: false, error: 'Sanitizer removed all content' };
    }
    return { ok: true, html: cleaned };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default function SvgBlock({ raw, fallbackCode }: Props) {
  const { t } = useTranslation('chat');
  const result = useMemo(() => sanitizeSvg(raw), [raw]);

  if (!result.ok) {
    return (
      <div className="my-3 rounded-lg border border-red-500/30 bg-red-900/10 overflow-hidden">
        <div className="px-3 py-1.5 bg-red-900/20 border-b border-red-500/30">
          <span className="text-[12px] uppercase tracking-wider text-red-400 font-medium">
            {t('svgError')}
          </span>
        </div>
        <div className="p-3 text-sm text-red-300">{result.error}</div>
        <pre className="p-3 pt-0 text-[13px] text-gray-500 overflow-x-auto">
          <code>{fallbackCode}</code>
        </pre>
      </div>
    );
  }

  const openInNewTab = () => {
    const blob = new Blob([result.html], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    // Revoke after a minute — long enough for the new tab to load
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(result.html);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  return (
    <div className="my-3 rounded-lg border border-surface-700/40 bg-surface-900/40 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-800/40 border-b border-surface-700/30">
        <span className="text-[12px] uppercase tracking-wider text-gray-500 font-medium">SVG</span>
        <div className="flex gap-1">
          <button
            onClick={copySource}
            className="text-[12px] px-2 py-0.5 rounded bg-surface-700/40 hover:bg-surface-700/60 text-gray-400 hover:text-gray-200 transition-colors"
            title={t('copySvgSource')}
          >
            {t('copy')}
          </button>
          <button
            onClick={openInNewTab}
            className="text-[12px] px-2 py-0.5 rounded bg-surface-700/40 hover:bg-surface-700/60 text-gray-400 hover:text-gray-200 transition-colors"
            title={t('openInNewTab')}
          >
            {t('open')}
          </button>
        </div>
      </div>
      {/* Inline SVG — injected into main document, no iframe. */}
      {/* Tailwind: child svg constrained to parent width, height auto. */}
      <div
        className="flex justify-center p-3 [&>svg]:max-w-full [&>svg]:h-auto"
        dangerouslySetInnerHTML={{ __html: result.html }}
      />
    </div>
  );
}
