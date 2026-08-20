// Owns: iframe inject script for HTML inline-edit. Public API: wrapHtmlWithInjector, INJECT_MESSAGE_TYPES.
// See README.md.
//
// The iframe (sandbox="allow-scripts allow-same-origin") cannot expose its
// `window.getSelection()` to the parent React tree directly — even with
// allow-same-origin, selection events stay inside the iframe. We solve this
// by injecting a small script that:
//   1. Listens for `mouseup` and `keyup` inside the iframe document.
//   2. Reads the active selection + a ~120-char DOM context window before/after.
//   3. Computes the FIRST client rect of the selection range (multi-line safe).
//   4. Posts the result to the parent via postMessage with a stable type tag.
// The parent translates iframe-local rect coordinates to viewport coordinates
// using `iframe.getBoundingClientRect()` and feeds them into useInlineEdit's
// `beginPrompting()`. Same diff/apply/sanitize path as markdown.
//
// Phase 1.5g (visual outline overlay):
//   On selection, the inject script also draws two fixed-position overlay
//   divs on top of the iframe document — a cyan dashed outline around the
//   selection rect, and an amber solid outline around the wrapping element.
//   The parent forwards the active scope (selection vs parent) via
//   TOWER_INLINE_EDIT_OUTLINE_STATE so the overlay can highlight which
//   region is the patch target. Overlays are pointer-events:none and z-index
//   max so they never interfere with the user's page or the selection
//   itself, and they're stripped on cancel + on outerHTML capture (the
//   sentinel pass already accounts for our injector script — outline
//   markers go through the same removal pipeline so they can never leak
//   into the patched-back HTML).

export const INJECT_MESSAGE_TYPES = {
  /** iframe → parent: a non-empty text selection happened. */
  SELECTION: 'TOWER_INLINE_EDIT_SELECTION',
  /** iframe → parent: the previous selection was cleared (clicked elsewhere). */
  CLEAR: 'TOWER_INLINE_EDIT_CLEAR',
  /** parent → iframe: clear any active selection (e.g. on Esc). */
  CANCEL: 'TOWER_INLINE_EDIT_CANCEL',
  /**
   * parent → iframe: the SelectionBar's scope toggle changed (or the prompt
   * bar opened/closed). Payload `{ active: 'selection' | 'parent' | null }`
   * tells the inject script which outline to bold + glow. `null` removes
   * outlines entirely (used when the parent transitions back to idle).
   */
  OUTLINE_STATE: 'TOWER_INLINE_EDIT_OUTLINE_STATE',
  /**
   * iframe → parent: user clicked an outline label to switch scope.
   * Payload `{ scope: 'selection' | 'parent' }`. Phase 1.5h direct-
   * manipulation: scope toggle moves from a SelectionBar pill row onto
   * the outline itself, so users see *and* drive scope from the same
   * spot.
   */
  SCOPE_CLICK: 'TOWER_INLINE_EDIT_SCOPE_CLICK',
} as const;

/**
 * Marker attribute on our injected `<script>` tag. Lets us detect and strip
 * existing injectors from incoming HTML so they don't compound when the user
 * applies multiple edits.
 *
 * Background (load-bearing): in Phase 1.5c we settled on "iframe outerHTML
 * is source of truth". That means each apply round-trip serializes the
 * iframe document — *including* our injector — back to disk. Without
 * cleanup, every apply adds another copy of the script. Six edits → six
 * scripts → markup corruption (browsers re-parse around the duplicates).
 */
export const INJECTOR_MARKER_ATTR = 'data-tower-inline-edit-injector';

/**
 * Marker attribute on our injected outline overlay divs + style tag. Same
 * accumulation problem as the script tag — outerHTML capture serializes
 * everything inside the document, so without an aggressive strip these
 * leak onto disk. We keep the attribute-name distinct from the script
 * marker so a regex targeted at one never accidentally bites the other.
 */
export const OUTLINE_MARKER_ATTR = 'data-tower-inline-edit-outline';

/**
 * Regex matching a single injector-tagged `<script>...</script>` block.
 * Multiline + non-greedy so it works on the full outerHTML serialization.
 */
const INJECTOR_SCRIPT_RE =
  /<script\b[^>]*\bdata-tower-inline-edit-injector\b[^>]*>[\s\S]*?<\/script>\s*/gi;

/**
 * Regex matching outline-tagged divs (the overlay rects), spans (the label
 * chips), AND the outline stylesheet. We tag all three with the same
 * attribute name so a single regex sweeps them in one pass; non-greedy
 * `[\s\S]*?` close is reliable because we strip *labels first* (innermost
 * nesting), then outline divs become leaf-like. Trailing whitespace eats
 * the newline we typically inject before each tag for readability.
 *
 * NOTE on nesting: outline divs contain a `<span>` label child carrying
 * the same OUTLINE_ATTR. A naive single-pass non-greedy regex would pair
 * outer-open with the *label's* close tag. We solve that by making the
 * label a `<span>` (different tag) — `<div>...<span>...</span>...</div>`
 * — and the regex's close-tag alternation `</(?:div|span|style)>` is
 * still ambiguous, so we sort removals by *position* in `cleaned` and
 * pre-strip labels in a first sweep before tackling the divs.
 */
const OUTLINE_NODE_RE =
  /<(?:div|span|style)\b[^>]*\bdata-tower-inline-edit-outline\b[^>]*>[\s\S]*?<\/(?:div|span|style)>\s*/gi;
/**
 * Inner-first label regex — matches just `<span ...data-tower-inline-edit-outline...>...</span>`
 * so we can strip labels before the outer outline divs (avoiding the
 * non-greedy nesting trap where outer-open pairs with inner-close).
 */
const OUTLINE_LABEL_RE =
  /<span\b[^>]*\bdata-tower-inline-edit-outline\b[^>]*>[\s\S]*?<\/span>\s*/gi;

/** Strip every injector script we previously added. Safe to run on input
 *  that contains zero or many injectors. */
export function stripInjectorScripts(html: string): string {
  return html.replace(INJECTOR_SCRIPT_RE, '');
}

/** Strip outline overlay nodes (divs + spans + style) we previously
 *  injected. Idempotent and order-independent — runs alongside
 *  stripInjectorScripts in `wrapHtmlWithInjector` so accumulated outline
 *  cruft from prior apply round-trips never reaches the user.
 *
 *  Two-pass: labels (spans) first to avoid the nested non-greedy trap
 *  where an outer outline div's regex match would terminate at the
 *  label's `</span>`. After labels are gone, outline divs are leaf-like
 *  and the wider regex sweeps them cleanly.
 */
export function stripOutlineNodes(html: string): string {
  return html.replace(OUTLINE_LABEL_RE, '').replace(OUTLINE_NODE_RE, '');
}

export interface IframeSelectionMessage {
  type: typeof INJECT_MESSAGE_TYPES.SELECTION;
  /** Plain text selected by the user (DOM textContent). */
  text: string;
  /** First client rect of the selection range, in iframe-local coordinates. */
  rect: { top: number; left: number; width: number; height: number };
  /**
   * Bottom of the LAST client rect of the selection (iframe-local coords).
   * Lets the floating bar sit below the entire selection, not just the
   * first line. Parent translates to viewport coords before forwarding.
   */
  bottomMost?: number;
  /**
   * Snapshot of the iframe's full outerHTML at the moment of selection,
   * with the marker sentinels removed. This is the source-of-truth content
   * we slice with rawStart/rawEnd and patch on apply.
   */
  rawHtml: string;
  /** Byte offset within rawHtml where SELECTION starts. */
  rawStart: number;
  /** Byte offset within rawHtml where SELECTION ends. */
  rawEnd: number;
  /**
   * If the selection sits inside a wrapping element (not body / html), we
   * also report that element's boundary in rawHtml. The frontend uses this
   * to offer a "select <tag> as a whole" toggle so users can patch the
   * element itself (e.g. delete a button) without re-dragging.
   */
  parentTagName?: string;
  parentRawStart?: number;
  parentRawEnd?: number;
  /** Optional plain-text hints kept for compatibility / debugging only. */
  beforeHint?: string;
  afterHint?: string;
}

/**
 * Build the inject script as a serialized string. Self-contained (no closures
 * over outer scope) so it survives the Blob → iframe boundary.
 */
function buildInjectScript(selectionLabel: string): string {
  // Note: this code runs INSIDE the iframe, so `window.parent` is the Tower
  // React app. Keep it tiny and dependency-free.
  return `
(function () {
  var TYPE_SEL = '${INJECT_MESSAGE_TYPES.SELECTION}';
  var TYPE_CLEAR = '${INJECT_MESSAGE_TYPES.CLEAR}';
  var TYPE_CANCEL = '${INJECT_MESSAGE_TYPES.CANCEL}';
  var TYPE_OUTLINE = '${INJECT_MESSAGE_TYPES.OUTLINE_STATE}';
  var TYPE_SCOPE_CLICK = '${INJECT_MESSAGE_TYPES.SCOPE_CLICK}';
  var OUTLINE_ATTR = '${OUTLINE_MARKER_ATTR}';
  var HINT_LEN = 120;
  var pending = false;
  // Strip any injector-tagged script blocks from the serialized outerHTML
  // before it leaves the iframe. Critical: this script body must NOT contain
  // the literal sequence "</" + "script" anywhere — the HTML parser would
  // terminate our <script> tag at that point. Build the closing-tag string
  // via concatenation so it never appears as a single token.
  var SCRIPT_CLOSE = '</' + 'script>';
  var SCRIPT_OPEN_RE = new RegExp(
    '<script\\\\b[^>]*\\\\bdata-tower-inline-edit-injector\\\\b[^>]*>',
    'gi'
  );
  // Same pattern for outline-tagged <div>, <span> (label) and <style>
  // nodes. The overlay divs / labels / style tag carry OUTLINE_ATTR so
  // they're easy to spot. Three openers per regex (alternation) — the
  // span case is for the label chip nested inside each outline div.
  var OUTLINE_OPEN_RE = new RegExp(
    '<(?:div|span|style)\\\\b[^>]*\\\\bdata-tower-inline-edit-outline\\\\b[^>]*>',
    'gi'
  );

  function findCloseTag(html, openIdx, openLen) {
    // Find the matching </tag> for an opener whose first letter we extract
    // from the html slice. Used by both injector-script and outline strip.
    // The label-then-outline removal order in callers (labels stripped
    // first as inner-most leaves) guarantees that by the time we look up
    // a div's close, its span child is already gone, so the next </div>
    // we find is the right one.
    var slice = html.slice(openIdx, openIdx + 32).toLowerCase();
    var tag = 'script';
    if (slice.indexOf('<div') === 0) tag = 'div';
    else if (slice.indexOf('<span') === 0) tag = 'span';
    else if (slice.indexOf('<style') === 0) tag = 'style';
    var close = '</' + tag + '>';
    return { idx: html.indexOf(close, openIdx + openLen), len: close.length };
  }

  function cleanOuterHtml(html) {
    var out = html;
    // Loop until no injector-tagged opener remains. For each opener, find
    // the matching close tag (built via concat above) and excise.
    while (true) {
      SCRIPT_OPEN_RE.lastIndex = 0;
      var m = SCRIPT_OPEN_RE.exec(out);
      if (!m) break;
      var endIdx = out.indexOf(SCRIPT_CLOSE, m.index + m[0].length);
      if (endIdx < 0) break;
      out = out.slice(0, m.index) + out.slice(endIdx + SCRIPT_CLOSE.length);
    }
    // Same pass for outline overlay nodes (div + style). The outline
    // builder always closes with the matching tag, so findCloseTag's
    // tag-aware lookup is exact.
    while (true) {
      OUTLINE_OPEN_RE.lastIndex = 0;
      var om = OUTLINE_OPEN_RE.exec(out);
      if (!om) break;
      var c = findCloseTag(out, om.index, om[0].length);
      if (c.idx < 0) break;
      out = out.slice(0, om.index) + out.slice(c.idx + c.len);
    }
    return out;
  }

  function readHints(range) {
    var before = '', after = '';
    try {
      var br = document.createRange();
      br.selectNodeContents(document.body);
      br.setEnd(range.startContainer, range.startOffset);
      before = br.toString().slice(-HINT_LEN);
    } catch (_) {}
    try {
      var ar = document.createRange();
      ar.selectNodeContents(document.body);
      ar.setStart(range.endContainer, range.endOffset);
      after = ar.toString().slice(0, HINT_LEN);
    } catch (_) {}
    return { before: before, after: after };
  }

  // Compute the raw-HTML byte offsets of the selection by injecting up to
  // four text-node sentinels (selection start/end + optional parent
  // element start/end) at the boundaries, serializing the document, and
  // searching for them. Text nodes leave HTML structure untouched — only
  // character offsets shift, which we account for.
  //
  // Sentinels are ASCII-only with a per-call random nonce, so they survive
  // outerHTML serialization untouched (no entity escaping) and won't collide
  // with anything in real-world HTML.
  function captureRawOffsets(range) {
    var nonce = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    var SS = '__TOWER_S_' + nonce + '__';
    var SE = '__TOWER_E_' + nonce + '__';
    var PS = '__TOWER_PS_' + nonce + '__';
    var PE = '__TOWER_PE_' + nonce + '__';

    var startNode = document.createTextNode(SS);
    var endNode = document.createTextNode(SE);

    // Insert selection end first (clone so we don't mutate the live range),
    // then start. Doing end-before-start keeps offsets stable for the
    // start insertion.
    var endRange = range.cloneRange();
    endRange.collapse(false);
    endRange.insertNode(endNode);
    var startRange = range.cloneRange();
    startRange.collapse(true);
    startRange.insertNode(startNode);

    // Find the wrapping element (skip text nodes). We don't offer parent
    // scope when the wrapper is body / html — those aren't meaningful
    // "select me as a whole" targets.
    var anchor = range.commonAncestorContainer;
    if (anchor && anchor.nodeType === 3) anchor = anchor.parentNode;
    var parentEl = null;
    if (
      anchor &&
      anchor.nodeType === 1 &&
      anchor !== document.body &&
      anchor !== document.documentElement &&
      anchor.parentNode
    ) {
      parentEl = anchor;
    }

    var pStartNode = null, pEndNode = null;
    var parentTagName = '';
    if (parentEl) {
      parentTagName = String(parentEl.tagName || '').toLowerCase();
      pStartNode = document.createTextNode(PS);
      pEndNode = document.createTextNode(PE);
      // Place markers immediately outside the element on both sides so the
      // raw boundary captures the FULL outerHTML (including the open/close
      // tags themselves).
      parentEl.parentNode.insertBefore(pStartNode, parentEl);
      parentEl.parentNode.insertBefore(pEndNode, parentEl.nextSibling);
    }

    var html = '';
    var idxSS = -1, idxSE = -1, idxPS = -1, idxPE = -1;
    try {
      html = document.documentElement.outerHTML;
      idxSS = html.indexOf(SS);
      idxSE = html.indexOf(SE);
      if (parentEl) {
        idxPS = html.indexOf(PS);
        idxPE = html.indexOf(PE);
      }
    } finally {
      // Always remove the sentinels, even if outerHTML / indexOf threw.
      [startNode, endNode, pStartNode, pEndNode].forEach(function (n) {
        try { if (n && n.parentNode) n.parentNode.removeChild(n); } catch (_) {}
      });
    }

    if (idxSS < 0 || idxSE < 0 || idxSE < idxSS) return null;

    // Build a sorted list of every removable substring (sentinels + injector
    // script blocks + outline nodes) and strip them in one pass while
    // updating the four offsets we care about. Using a unified pipeline
    // keeps the offset math honest regardless of how the items interleave.
    var removals = [
      { pos: idxSS, len: SS.length, kind: 's_start' },
      { pos: idxSE, len: SE.length, kind: 's_end' }
    ];
    if (parentEl && idxPS >= 0 && idxPE >= 0) {
      removals.push({ pos: idxPS, len: PS.length, kind: 'p_start' });
      removals.push({ pos: idxPE, len: PE.length, kind: 'p_end' });
    }
    // Find injector <script> blocks the same way cleanOuterHtml does — opener
    // regex + indexOf for the close, so a literal close-tag substring inside
    // the injector body doesn't fool the walker.
    SCRIPT_OPEN_RE.lastIndex = 0;
    var m;
    while ((m = SCRIPT_OPEN_RE.exec(html)) !== null) {
      var closeIdx = html.indexOf(SCRIPT_CLOSE, m.index + m[0].length);
      if (closeIdx < 0) break;
      var blockEnd = closeIdx + SCRIPT_CLOSE.length;
      removals.push({ pos: m.index, len: blockEnd - m.index, kind: 'injector' });
      SCRIPT_OPEN_RE.lastIndex = blockEnd;
    }
    // Same walk for outline overlay nodes. They're created *after* selection
    // capture in the normal flow, so usually absent here — but a stale call
    // (e.g. user re-selects without dismissing first) can leave outlines
    // around. Strip them out of the captured rawHtml so they never reach
    // the patcher / disk.
    //
    // Each outline div now contains a label <span> child. Walking with
    // OUTLINE_OPEN_RE finds *both* the outer div opener and the inner
    // span opener (the alternation matches all three tag types). To
    // avoid double-counting (outer's range covers inner), we collect
    // candidates first then drop any whose range is fully contained
    // within an earlier outer one.
    OUTLINE_OPEN_RE.lastIndex = 0;
    var om;
    var outlineCandidates = [];
    while ((om = OUTLINE_OPEN_RE.exec(html)) !== null) {
      var c = findCloseTag(html, om.index, om[0].length);
      if (c.idx < 0) break;
      var oend = c.idx + c.len;
      outlineCandidates.push({ start: om.index, end: oend });
      OUTLINE_OPEN_RE.lastIndex = oend;
    }
    // Sort outermost-first by start, then drop nested.
    outlineCandidates.sort(function (a, b) {
      if (a.start !== b.start) return a.start - b.start;
      return b.end - a.end; // longer (outer) first when starts tie
    });
    var lastOuterEnd = -1;
    for (var oi = 0; oi < outlineCandidates.length; oi++) {
      var cand = outlineCandidates[oi];
      if (cand.start < lastOuterEnd) continue; // contained in prior outer
      removals.push({ pos: cand.start, len: cand.end - cand.start, kind: 'outline' });
      lastOuterEnd = cand.end;
    }
    removals.sort(function (a, b) { return a.pos - b.pos; });

    // Walk removals in order; build cleaned string and resolve sentinel
    // positions to their post-strip offsets.
    var cleaned = '';
    var lastEnd = 0;
    var cumRemoved = 0;
    var resolved = {};
    for (var i = 0; i < removals.length; i++) {
      var r = removals[i];
      cleaned += html.slice(lastEnd, r.pos);
      if (r.kind !== 'injector' && r.kind !== 'outline') {
        // Sentinel — record its post-strip position.
        resolved[r.kind] = r.pos - cumRemoved;
      }
      cumRemoved += r.len;
      lastEnd = r.pos + r.len;
    }
    cleaned += html.slice(lastEnd);

    var result = {
      rawHtml: cleaned,
      rawStart: resolved.s_start,
      rawEnd: resolved.s_end,
      parentEl: parentEl
    };
    if (parentEl && resolved.p_start !== undefined && resolved.p_end !== undefined) {
      result.parentTagName = parentTagName;
      result.parentRawStart = resolved.p_start;
      result.parentRawEnd = resolved.p_end;
    }
    return result;
  }

  // ---------------- Outline overlay ----------------
  //
  // Two fixed-position divs that visually hint at the patch target:
  //   - selection outline  (cyan dashed, follows the rect[0] of selection)
  //   - parent outline     (amber solid, follows the wrapping element box)
  // The parent forwards an OUTLINE_STATE message whenever the SelectionBar
  // pill changes, and we toggle [data-active="true"] / [data-dim="true"] on
  // each div so CSS handles the highlight without per-frame JS.
  //
  // pointer-events:none is non-negotiable — the user must still be able to
  // click/drag through the overlay, including releasing a brand-new
  // selection on top of an existing parent outline.

  function ensureOutlineStyles() {
    if (document.querySelector('style[' + OUTLINE_ATTR + '="style"]')) return;
    var style = document.createElement('style');
    style.setAttribute(OUTLINE_ATTR, 'style');
    style.textContent = [
      '.tower-inline-edit-outline-selection,',
      '.tower-inline-edit-outline-parent {',
      '  position: fixed;',
      '  pointer-events: none;',
      '  z-index: 2147483647;',
      '  border-radius: 4px;',
      '  isolation: isolate;',
      '  transition: box-shadow 0.15s ease, background-color 0.15s ease, border-width 0.15s ease, opacity 0.15s ease;',
      '}',
      '.tower-inline-edit-outline-selection {',
      '  border: 2px dashed #38bdf8;',
      '  box-shadow: 0 0 0 0 rgba(56, 189, 248, 0);',
      '}',
      '.tower-inline-edit-outline-selection[data-active="true"] {',
      '  box-shadow: 0 0 12px rgba(56, 189, 248, 0.5);',
      '  background: rgba(56, 189, 248, 0.08);',
      '}',
      '.tower-inline-edit-outline-parent {',
      '  border: 2px solid #f59e0b;',
      '  box-shadow: 0 0 0 0 rgba(245, 158, 11, 0);',
      '}',
      '.tower-inline-edit-outline-parent[data-active="true"] {',
      '  border-width: 3px;',
      '  box-shadow: 0 0 16px rgba(245, 158, 11, 0.5);',
      '  background: rgba(245, 158, 11, 0.06);',
      '}',
      '.tower-inline-edit-outline-selection[data-dim="true"],',
      '.tower-inline-edit-outline-parent[data-dim="true"] {',
      '  opacity: 0.35;',
      '}',
      // Labels — small chips anchored to the outline corners. Only the
      // label is interactive (pointer-events: auto); the outline body
      // stays pointer-events:none so iframe content (links, buttons) is
      // never blocked.
      '.tower-inline-edit-outline-label {',
      '  position: absolute;',
      '  top: -10px;',
      '  pointer-events: auto;',
      '  cursor: pointer;',
      '  font-size: 12px;',
      '  font-family: ui-sans-serif, system-ui, sans-serif;',
      '  font-weight: 600;',
      '  line-height: 1;',
      '  padding: 2px 6px;',
      '  border-radius: 3px;',
      '  user-select: none;',
      '  white-space: nowrap;',
      '  transition: opacity 0.15s ease, box-shadow 0.15s ease, transform 0.1s ease;',
      '  opacity: 0.5;',
      '}',
      '.tower-inline-edit-outline-label:hover {',
      '  opacity: 1 !important;',
      '  transform: translateY(-1px);',
      '}',
      '.tower-inline-edit-outline-selection .tower-inline-edit-outline-label {',
      '  left: -2px;',
      '  background: #38bdf8;',
      '  color: #0c1f2c;',
      '}',
      '.tower-inline-edit-outline-parent .tower-inline-edit-outline-label {',
      '  right: -2px;',
      '  background: #f59e0b;',
      '  color: #2a1a04;',
      '}',
      '.tower-inline-edit-outline-selection[data-active="true"] .tower-inline-edit-outline-label,',
      '.tower-inline-edit-outline-parent[data-active="true"] .tower-inline-edit-outline-label {',
      '  opacity: 1;',
      '  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);',
      '}',
      '.tower-inline-edit-outline-selection[data-dim="true"] .tower-inline-edit-outline-label,',
      '.tower-inline-edit-outline-parent[data-dim="true"] .tower-inline-edit-outline-label {',
      '  opacity: 0.7;',
      '}'
    ].join('\\n');
    (document.head || document.documentElement).appendChild(style);
  }

  // Track the most recent rects + parent element so OUTLINE_STATE messages
  // arriving from the parent can update active/dim flags without re-running
  // a fresh capture. Stored on a closure-local object so cancellation
  // wipes them along with the DOM nodes.
  var outlineState = {
    selectionEl: null,
    parentEl: null,
    selectionRect: null,
    parentRect: null,
    parentNode: null
  };

  function buildOutlineDiv(kind, rect, labelText) {
    var div = document.createElement('div');
    div.setAttribute(OUTLINE_ATTR, kind);
    div.className = kind === 'parent'
      ? 'tower-inline-edit-outline-parent'
      : 'tower-inline-edit-outline-selection';
    div.style.top = rect.top + 'px';
    div.style.left = rect.left + 'px';
    div.style.width = rect.width + 'px';
    div.style.height = rect.height + 'px';
    // Label child — clickable chip anchored to the outline. Direct-
    // manipulation entry point: clicking the label posts SCOPE_CLICK
    // back to the parent so the SelectionBar (which no longer carries
    // a scope pill row) can flip scope without a separate UI element.
    //
    // Use <span> (not <div>) so the strip regex's two-pass walker
    // (labels first, then outline divs) doesn't mis-pair on nesting.
    var label = document.createElement('span');
    label.setAttribute(OUTLINE_ATTR, 'label');
    label.className = 'tower-inline-edit-outline-label';
    label.dataset.scope = kind === 'parent' ? 'parent' : 'selection';
    label.textContent = labelText || (kind === 'parent' ? 'parent' : ${JSON.stringify(selectionLabel)});
    label.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      try {
        window.parent.postMessage({
          type: TYPE_SCOPE_CLICK,
          scope: this.dataset.scope
        }, '*');
      } catch (_) { /* no-op */ }
    }, true);
    // Stop pointer/touch before the native selection can collapse and emit
    // CLEAR ahead of the scope click. Mouse guards remain for older browsers.
    ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup'].forEach(function (type) {
      label.addEventListener(type, function (e) {
        e.preventDefault();
        e.stopPropagation();
      }, { capture: true, passive: false });
    });
    div.appendChild(label);
    return div;
  }

  function removeOutlines() {
    var nodes = document.querySelectorAll('[' + OUTLINE_ATTR + ']');
    for (var i = 0; i < nodes.length; i++) {
      try { nodes[i].parentNode && nodes[i].parentNode.removeChild(nodes[i]); } catch (_) {}
    }
    outlineState.selectionEl = null;
    outlineState.parentEl = null;
    outlineState.selectionRect = null;
    outlineState.parentRect = null;
    outlineState.parentNode = null;
  }

  function drawOutlines(selectionRect, parentNode, defaultActive) {
    ensureOutlineStyles();
    // Always rebuild — selection + parent rects move every capture, and the
    // simplest correct path is wipe-and-redraw. Stripping the outline DOM
    // nodes themselves (not the <style>) guarantees no stale boxes linger
    // when the user starts a new selection in a different region.
    var existing = document.querySelectorAll(
      '[' + OUTLINE_ATTR + '="selection"], [' + OUTLINE_ATTR + '="parent"]'
    );
    for (var i = 0; i < existing.length; i++) {
      try { existing[i].parentNode && existing[i].parentNode.removeChild(existing[i]); } catch (_) {}
    }

    var selDiv = buildOutlineDiv('selection', selectionRect, ${JSON.stringify(selectionLabel)});
    document.body.appendChild(selDiv);
    outlineState.selectionEl = selDiv;
    outlineState.selectionRect = selectionRect;

    var parRect = null;
    if (parentNode && typeof parentNode.getBoundingClientRect === 'function') {
      var pr = parentNode.getBoundingClientRect();
      parRect = { top: pr.top, left: pr.left, width: pr.width, height: pr.height };
      var tag = String(parentNode.tagName || '').toLowerCase();
      var parDiv = buildOutlineDiv('parent', parRect, '<' + tag + '>');
      document.body.appendChild(parDiv);
      outlineState.parentEl = parDiv;
      outlineState.parentRect = parRect;
      outlineState.parentNode = parentNode;
    }

    applyOutlineActive(defaultActive || 'selection');
  }

  function applyOutlineActive(active) {
    var sel = outlineState.selectionEl;
    var par = outlineState.parentEl;
    if (sel) {
      if (active === 'selection') {
        sel.setAttribute('data-active', 'true');
        sel.removeAttribute('data-dim');
      } else if (active === 'parent') {
        sel.removeAttribute('data-active');
        sel.setAttribute('data-dim', 'true');
      } else {
        sel.removeAttribute('data-active');
        sel.removeAttribute('data-dim');
      }
    }
    if (par) {
      if (active === 'parent') {
        par.setAttribute('data-active', 'true');
        par.removeAttribute('data-dim');
      } else if (active === 'selection') {
        par.removeAttribute('data-active');
        par.setAttribute('data-dim', 'true');
      } else {
        par.removeAttribute('data-active');
        par.removeAttribute('data-dim');
      }
    }
  }

  function capture() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      try {
        var sel = document.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
          window.parent.postMessage({ type: TYPE_CLEAR }, '*');
          return;
        }
        var text = sel.toString();
        if (!text || !text.trim()) {
          window.parent.postMessage({ type: TYPE_CLEAR }, '*');
          return;
        }
        var range = sel.getRangeAt(0);
        var rects = range.getClientRects();
        if (!rects || rects.length === 0) return;
        var r = rects[0];
        // Last rect's bottom — used by the parent to place the floating bar
        // beneath the WHOLE selection (multi-line aware). Falls back to the
        // first rect's bottom for single-line selections.
        var lastRect = rects[rects.length - 1];
        var bottomMost = lastRect.bottom;
        var hints = readHints(range);

        var raw = captureRawOffsets(range);
        if (!raw) return; // marker capture failed — abort silently

        // Draw the visual outline overlay BEFORE posting selection so the
        // user sees the highlight as soon as the bar opens. Default active
        // scope is 'selection' — the parent will send OUTLINE_STATE soon
        // after if the user toggles via the SelectionBar pill.
        try {
          drawOutlines(
            { top: r.top, left: r.left, width: r.width, height: r.height },
            raw.parentEl,
            'selection'
          );
        } catch (_) { /* outline is decorative; never block selection */ }

        var msg = {
          type: TYPE_SEL,
          text: text,
          rect: { top: r.top, left: r.left, width: r.width, height: r.height },
          bottomMost: bottomMost,
          rawHtml: raw.rawHtml,
          rawStart: raw.rawStart,
          rawEnd: raw.rawEnd,
          beforeHint: hints.before,
          afterHint: hints.after
        };
        if (raw.parentTagName) {
          msg.parentTagName = raw.parentTagName;
          msg.parentRawStart = raw.parentRawStart;
          msg.parentRawEnd = raw.parentRawEnd;
        }
        window.parent.postMessage(msg, '*');
      } catch (_e) { /* swallow — keep the host page usable */ }
    });
  }

  document.addEventListener('mouseup', capture, true);
  document.addEventListener('keyup', capture, true);
  // selectionchange covers touch / IME / programmatic selection (e.g. user
  // long-presses on mobile to select a word). We debounce via the pending
  // flag so the rAF hit per frame stays low.
  document.addEventListener('selectionchange', capture, true);

  window.addEventListener('message', function (e) {
    if (!e || !e.data) return;
    if (e.data.type === TYPE_CANCEL) {
      try { document.getSelection().removeAllRanges(); } catch (_) {}
      removeOutlines();
      return;
    }
    if (e.data.type === TYPE_OUTLINE) {
      var active = e.data.active;
      if (active === null || active === undefined) {
        removeOutlines();
        return;
      }
      // outline already exists → just flip active flags. If the previous
      // selection got cleared (no overlay) we silently ignore — the parent
      // will re-trigger drawOutlines on the next selection.
      if (outlineState.selectionEl || outlineState.parentEl) {
        applyOutlineActive(active);
      }
      return;
    }
  });
})();
`;
}

/**
 * Wrap arbitrary HTML so that it includes the inject script.
 *
 * Self-cleanup: any pre-existing injector script (from a previous mount /
 * apply round-trip) is stripped first, along with any orphan outline
 * overlay nodes that may have leaked through (defense in depth — the
 * inject script's own outerHTML cleanup should already handle them).
 * Without this the injector accumulates exponentially because Phase
 * 1.5c's "iframe outerHTML is source of truth" model serializes the
 * document — including our script — back to disk on each apply. Six
 * edits used to mean six scripts plus markup corruption.
 *
 * Surgery is minimal otherwise: insert just before `</body>` if present,
 * otherwise append at the end. The injected `<script>` carries the
 * `data-tower-inline-edit-injector` attribute so we can find and strip it
 * on the way out.
 */
export function wrapHtmlWithInjector(html: string, selectionLabel = 'Selection'): string {
  const cleaned = stripOutlineNodes(stripInjectorScripts(html));
  const scriptTag = `<script ${INJECTOR_MARKER_ATTR}>${buildInjectScript(selectionLabel)}</script>`;
  // Case-insensitive search for the closing body tag.
  const bodyClose = /<\/body\s*>/i.exec(cleaned);
  if (bodyClose) {
    return cleaned.slice(0, bodyClose.index) + scriptTag + cleaned.slice(bodyClose.index);
  }
  return cleaned + scriptTag;
}
