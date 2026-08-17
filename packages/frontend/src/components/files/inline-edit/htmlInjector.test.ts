import { describe, it, expect } from 'vitest';
import {
  wrapHtmlWithInjector,
  stripInjectorScripts,
  stripOutlineNodes,
  INJECT_MESSAGE_TYPES,
  OUTLINE_MARKER_ATTR,
} from './htmlInjector';

/**
 * Counts how many <script> *openers* in the document carry the injector
 * marker attribute. Plain `out.match(MARKER, 'g')` is too loose because the
 * marker name also appears inside the script body (the inject script needs
 * the literal string to recognize itself for cleanup), so a substring count
 * of 2 is normal for one injected script.
 */
function countInjectorScriptTags(html: string): number {
  return (html.match(/<script\b[^>]*\bdata-tower-inline-edit-injector\b[^>]*>/gi) || []).length;
}

/** Counts outline-tagged DOM nodes (excluding the prose mention inside the
 *  inject script body). Symmetric to countInjectorScriptTags — we look for
 *  real `<div|span|style ... data-tower-inline-edit-outline ...>` openers.
 *  Phase 1.5h added <span> labels nested inside each outline div. */
function countOutlineNodes(html: string): number {
  return (
    html.match(/<(?:div|span|style)\b[^>]*\bdata-tower-inline-edit-outline\b[^>]*>/gi) || []
  ).length;
}

describe('wrapHtmlWithInjector', () => {
  it('inserts the injector immediately before </body> when present', () => {
    const input = '<html><body><p>hello</p></body></html>';
    const out = wrapHtmlWithInjector(input);
    // Original content survives untouched
    expect(out).toContain('<p>hello</p>');
    // Script lands before the closing body tag
    const scriptIdx = out.indexOf('<script>');
    const bodyCloseIdx = out.indexOf('</body>');
    expect(scriptIdx).toBeGreaterThan(-1);
    expect(scriptIdx).toBeLessThan(bodyCloseIdx);
  });

  it('appends the injector at the end when there is no </body>', () => {
    const input = '<p>fragment without body</p>';
    const out = wrapHtmlWithInjector(input);
    expect(out.startsWith(input)).toBe(true);
    expect(out.endsWith('</script>')).toBe(true);
  });

  it('handles uppercase / spaced </BODY > variants', () => {
    const input = '<html><body>x</BODY >';
    const out = wrapHtmlWithInjector(input);
    const scriptIdx = out.indexOf('<script>');
    const bodyCloseIdx = out.search(/<\/body\s*>/i);
    expect(scriptIdx).toBeLessThan(bodyCloseIdx);
  });

  it('inserts exactly one <script> wrapper', () => {
    const input = '<html><body>a</body></html>';
    const out = wrapHtmlWithInjector(input);
    // Count *real* <script> opening tags (with at least one attribute) —
    // the inject script body has comments mentioning '<script>' in prose,
    // which a permissive regex would mistakenly include. Our injected tag
    // always has the data-tower-inline-edit-injector attribute, which
    // disambiguates from any prose mention.
    expect(countInjectorScriptTags(out)).toBe(1);
  });

  it('embeds the canonical message type tags for parent ↔ iframe handshake', () => {
    const out = wrapHtmlWithInjector('<body></body>');
    expect(out).toContain(INJECT_MESSAGE_TYPES.SELECTION);
    expect(out).toContain(INJECT_MESSAGE_TYPES.CLEAR);
    expect(out).toContain(INJECT_MESSAGE_TYPES.CANCEL);
  });

  it('preserves user <script> tags inside the page', () => {
    const input = '<body><script>console.log("user")</script><p>x</p></body>';
    const out = wrapHtmlWithInjector(input);
    expect(out).toContain('console.log("user")');
    // User script (no marker) + 1 injector script (with marker)
    expect(out).toContain('console.log("user")');
    expect(countInjectorScriptTags(out)).toBe(1);
  });

  it('marks the injected script with data-tower-inline-edit-injector', () => {
    const out = wrapHtmlWithInjector('<body></body>');
    expect(out).toMatch(/<script\s+data-tower-inline-edit-injector\b/);
  });
});

describe('stripInjectorScripts (load-bearing — prevents script accumulation)', () => {
  it('removes a single tagged injector', () => {
    const input = '<body><p>x</p><script data-tower-inline-edit-injector>foo()</script></body>';
    expect(stripInjectorScripts(input)).toBe('<body><p>x</p></body>');
  });
  it('removes multiple tagged injectors (the production bug we just shipped)', () => {
    const six = Array(6).fill(0).map(() =>
      '<script data-tower-inline-edit-injector>(function(){})()</script>'
    ).join('');
    const input = `<body><p>x</p>${six}</body>`;
    const out = stripInjectorScripts(input);
    expect(out).not.toContain('data-tower-inline-edit-injector');
    expect(out).toContain('<p>x</p>');
  });
  it('preserves user <script> tags without our marker', () => {
    const input = '<body><script>userCode()</script><script data-tower-inline-edit-injector>injectorCode()</script></body>';
    const out = stripInjectorScripts(input);
    expect(out).toContain('userCode()');
    expect(out).not.toContain('injectorCode()');
  });
  it('is idempotent — already-clean HTML passes through unchanged', () => {
    const input = '<body><p>nothing to strip</p></body>';
    expect(stripInjectorScripts(input)).toBe(input);
  });
});

describe('wrapHtmlWithInjector — accumulation prevention (regression for the 6-script bug)', () => {
  it('wrapping an already-wrapped document still produces exactly one injector', () => {
    const once = wrapHtmlWithInjector('<body><p>hi</p></body>');
    const twice = wrapHtmlWithInjector(once);
    const thrice = wrapHtmlWithInjector(twice);
    expect(countInjectorScriptTags(thrice)).toBe(1);
  });
  it('user content survives across multiple wrap cycles', () => {
    let html = '<body><p>preserve me</p></body>';
    for (let i = 0; i < 5; i++) html = wrapHtmlWithInjector(html);
    expect(html).toContain('preserve me');
    expect(countInjectorScriptTags(html)).toBe(1);
  });
});

describe('stripOutlineNodes (Phase 1.5g — outline overlay cleanup)', () => {
  it('removes outline-tagged divs', () => {
    const input =
      '<body><p>x</p>' +
      '<div data-tower-inline-edit-outline="selection" class="tower-inline-edit-outline-selection" style="top:10px"></div>' +
      '<div data-tower-inline-edit-outline="parent" class="tower-inline-edit-outline-parent"></div>' +
      '</body>';
    const out = stripOutlineNodes(input);
    expect(out).not.toContain('data-tower-inline-edit-outline');
    expect(out).toContain('<p>x</p>');
  });
  it('removes the outline stylesheet', () => {
    const input =
      '<head><style data-tower-inline-edit-outline="style">.tower-inline-edit-outline-selection { color: red; }</style></head>' +
      '<body>x</body>';
    const out = stripOutlineNodes(input);
    expect(out).not.toContain('data-tower-inline-edit-outline');
    expect(out).not.toContain('tower-inline-edit-outline-selection { color: red; }');
    expect(out).toContain('<body>x</body>');
  });
  it('preserves user <div> and <style> tags without our marker', () => {
    const input =
      '<style>body { color: black }</style>' +
      '<div class="user-thing">user</div>' +
      '<div data-tower-inline-edit-outline="selection"></div>';
    const out = stripOutlineNodes(input);
    expect(out).toContain('user-thing');
    expect(out).toContain('color: black');
    expect(out).not.toContain('data-tower-inline-edit-outline');
  });
  it('is idempotent — already-clean HTML passes through unchanged', () => {
    const input = '<body><p>nothing to strip</p></body>';
    expect(stripOutlineNodes(input)).toBe(input);
  });
  it('strips multiple outline nodes in one pass', () => {
    const many = Array(4).fill(0).map((_, i) =>
      `<div data-tower-inline-edit-outline="selection" data-i="${i}"></div>`
    ).join('');
    const input = `<body><p>x</p>${many}</body>`;
    const out = stripOutlineNodes(input);
    expect(out).not.toContain('data-tower-inline-edit-outline');
    expect(out).toContain('<p>x</p>');
  });
});

describe('wrapHtmlWithInjector — outline cleanup on rewrap', () => {
  it('strips orphan outline nodes from incoming HTML', () => {
    // Simulate disk-saved HTML where outline overlay leaked through
    // (defense-in-depth — the inject script's own cleanup should
    // already prevent this, but if it ever fails wrapHtmlWithInjector
    // is the last line).
    //
    // Note: the inject script body itself mentions the marker attribute
    // as a literal string (it needs the literal to recognize itself for
    // cleanup), so a raw substring count of `data-tower-inline-edit-outline`
    // will be > 0 in any wrapped output. We assert on real DOM nodes
    // instead, via countOutlineNodes (which only matches openers).
    const dirty =
      '<body><p>real content</p>' +
      '<div data-tower-inline-edit-outline="selection" class="tower-inline-edit-outline-selection"></div>' +
      '<div data-tower-inline-edit-outline="parent" class="tower-inline-edit-outline-parent"></div>' +
      '<style data-tower-inline-edit-outline="style">.tower-inline-edit-outline-selection {}</style>' +
      '</body>';
    const out = wrapHtmlWithInjector(dirty);
    expect(out).toContain('real content');
    // Zero real outline DOM nodes survive — only the injector script body's
    // prose mention of the marker remains, which is harmless.
    expect(countOutlineNodes(out)).toBe(0);
  });
});

describe('inject script — outline message handling', () => {
  it('embeds OUTLINE_STATE message type for parent ↔ iframe handshake', () => {
    const out = wrapHtmlWithInjector('<body></body>');
    expect(out).toContain(INJECT_MESSAGE_TYPES.OUTLINE_STATE);
    expect(INJECT_MESSAGE_TYPES.OUTLINE_STATE).toBe('TOWER_INLINE_EDIT_OUTLINE_STATE');
  });
  it('exports the outline marker attribute for cleanup symmetry', () => {
    expect(OUTLINE_MARKER_ATTR).toBe('data-tower-inline-edit-outline');
  });
  it('embeds the outline CSS classes used by the overlay divs', () => {
    const out = wrapHtmlWithInjector('<body></body>');
    expect(out).toContain('tower-inline-edit-outline-selection');
    expect(out).toContain('tower-inline-edit-outline-parent');
  });
  it('embeds outline brand colors (cyan + amber)', () => {
    const out = wrapHtmlWithInjector('<body></body>');
    // cyan #38bdf8 (selection) + amber #f59e0b (parent) — brand-locked
    // load-bearing strings the inject style block injects at runtime.
    expect(out).toContain('#38bdf8');
    expect(out).toContain('#f59e0b');
  });
  it('uses pointer-events:none so the overlay never blocks selection', () => {
    const out = wrapHtmlWithInjector('<body></body>');
    expect(out).toContain('pointer-events: none');
  });
  it('uses z-index max so user pages can\'t cover the overlay', () => {
    const out = wrapHtmlWithInjector('<body></body>');
    expect(out).toContain('2147483647');
  });
});

describe('Phase 1.5h — outline labels (direct-manipulation scope toggle)', () => {
  it('exposes SCOPE_CLICK message type for label → parent handshake', () => {
    expect(INJECT_MESSAGE_TYPES.SCOPE_CLICK).toBe('TOWER_INLINE_EDIT_SCOPE_CLICK');
    const out = wrapHtmlWithInjector('<body></body>');
    expect(out).toContain(INJECT_MESSAGE_TYPES.SCOPE_CLICK);
  });
  it('embeds the label CSS class used by the chip', () => {
    const out = wrapHtmlWithInjector('<body></body>');
    expect(out).toContain('tower-inline-edit-outline-label');
  });
  it('embeds pointer-events:auto for the label so it stays clickable', () => {
    const out = wrapHtmlWithInjector('<body></body>');
    // Label CSS sets `pointer-events: auto` even though the outer outline
    // body keeps `pointer-events: none`. Both literal strings should appear.
    expect(out).toContain('pointer-events: auto');
    expect(out).toContain('pointer-events: none');
  });
  it('blocks pointer and touch events before mobile selection can collapse', () => {
    const out = wrapHtmlWithInjector('<body></body>');
    expect(out).toContain("'pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup'");
    expect(out).toContain('passive: false');
  });
  it('embeds dataset.scope assignment for SCOPE_CLICK payload routing', () => {
    const out = wrapHtmlWithInjector('<body></body>');
    // The inject script reads `this.dataset.scope` on click — the build
    // must include the literal string so we know wiring survived.
    expect(out).toContain('dataset.scope');
  });
  it('strips outline label spans from incoming HTML', () => {
    const dirty =
      '<body><p>real</p>' +
      '<div data-tower-inline-edit-outline="selection">' +
      '<span data-tower-inline-edit-outline="label">선택</span>' +
      '</div>' +
      '</body>';
    const out = stripOutlineNodes(dirty);
    expect(out).not.toContain('data-tower-inline-edit-outline');
    expect(out).toContain('<p>real</p>');
  });
  it('strips outline divs that contain a label span (nested non-greedy trap)', () => {
    // Regression for the strip regex's nested-non-greedy bug: outer-div-open
    // with inner-span-close would terminate prematurely if the regex were
    // run as a single pass. stripOutlineNodes does a labels-first sweep so
    // by the time the divs are processed they're leaf-like.
    const dirty =
      '<body><p>real</p>' +
      '<div data-tower-inline-edit-outline="parent" class="tower-inline-edit-outline-parent">' +
      '<span data-tower-inline-edit-outline="label">&lt;button&gt;</span>' +
      '</div>' +
      '<div data-tower-inline-edit-outline="selection">' +
      '<span data-tower-inline-edit-outline="label">선택</span>' +
      '</div>' +
      '</body>';
    const out = stripOutlineNodes(dirty);
    expect(out).not.toContain('data-tower-inline-edit-outline');
    expect(out).not.toContain('tower-inline-edit-outline-parent');
    expect(out).toContain('<p>real</p>');
  });
});
