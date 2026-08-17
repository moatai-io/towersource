// @vitest-environment jsdom
//
// Regression tests for the cross-block sweep race in MermaidBlock.
//
// Background — see workspace/decisions/2026-05-05-mermaid-block-race-fix.md
//
// Trigger: when N MermaidBlocks mount in the same tick, each effect's
// `sweepBroad()` ran a blanket `body > [id^="dmermaid-"]` query and removed
// *every* match — including measurement divs that mermaid v11 had attached on
// behalf of a sibling block, mid-render. Across the `await Diagram.fromText()`
// microtask boundary mermaid does `root.select(enclosingDivID).node()`, which
// then returns null → "Cannot read properties of null (reading 'firstChild')".
//
// Fix: a module-level `ACTIVE_RENDER_IDS` set tracks which renderIds are
// in-flight; `sweepOrphanMermaidNodes()` skips matches whose renderId is in
// that set. We test the helper directly (deterministic) and a simulated race
// (set bookkeeping survives concurrent mounts/unmounts).
//
// Note: we don't render <MermaidBlock /> itself here because
//   - it imports the real `mermaid` package which pulls heavy deps in jsdom,
//   - the bug is in the sweep helper, not the React tree, so a focused unit
//     test is more durable than wiring a full integration harness.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  __internalActiveRenderIds,
  extractRenderIdFromMermaidNode,
  sweepOrphanMermaidNodes,
} from './MermaidBlock';

beforeEach(() => {
  __internalActiveRenderIds.clear();
  document.body.innerHTML = '';
});

function makeMermaidNode(id: string) {
  const div = document.createElement('div');
  div.id = id;
  document.body.appendChild(div);
  return div;
}

describe('extractRenderIdFromMermaidNode', () => {
  it('strips the leading d from measurement-prefixed ids', () => {
    expect(extractRenderIdFromMermaidNode('dmermaid-abc-123')).toBe('mermaid-abc-123');
  });

  it('returns the id unchanged for non-prefixed mermaid ids', () => {
    expect(extractRenderIdFromMermaidNode('mermaid-abc-123')).toBe('mermaid-abc-123');
  });

  it('returns null for unrelated ids', () => {
    expect(extractRenderIdFromMermaidNode('some-random-div')).toBeNull();
    expect(extractRenderIdFromMermaidNode('')).toBeNull();
    expect(extractRenderIdFromMermaidNode(null)).toBeNull();
    expect(extractRenderIdFromMermaidNode(undefined)).toBeNull();
  });
});

describe('sweepOrphanMermaidNodes', () => {
  it('removes leaked nodes whose renderId is not active', () => {
    makeMermaidNode('dmermaid-aaa-1');
    makeMermaidNode('dmermaid-bbb-2');

    sweepOrphanMermaidNodes(__internalActiveRenderIds);

    expect(document.querySelectorAll('body > [id^="dmermaid-"]')).toHaveLength(0);
  });

  it('preserves nodes whose renderId is currently active (the race-fix invariant)', () => {
    // Simulates: sibling block A is mid-render (mermaid attached its
    // measurement div, control yielded across a microtask). Block B mounts
    // and runs its sweepBroad. The sibling's div MUST survive.
    __internalActiveRenderIds.add('mermaid-aaa-1');
    makeMermaidNode('dmermaid-aaa-1'); // sibling A's in-flight measurement
    makeMermaidNode('dmermaid-bbb-2'); // truly orphaned leak

    sweepOrphanMermaidNodes(__internalActiveRenderIds);

    expect(document.getElementById('dmermaid-aaa-1')).not.toBeNull();
    expect(document.getElementById('dmermaid-bbb-2')).toBeNull();
  });

  it('preserves un-prefixed mermaid render container while it is active', () => {
    __internalActiveRenderIds.add('mermaid-zzz-9');
    makeMermaidNode('mermaid-zzz-9'); // mermaid's enclosing wrapper

    sweepOrphanMermaidNodes(__internalActiveRenderIds);

    expect(document.getElementById('mermaid-zzz-9')).not.toBeNull();
  });

  it('does not touch unrelated body children', () => {
    const unrelated = document.createElement('div');
    unrelated.id = 'app-root';
    document.body.appendChild(unrelated);

    makeMermaidNode('dmermaid-orphan-x');

    sweepOrphanMermaidNodes(__internalActiveRenderIds);

    expect(document.getElementById('app-root')).not.toBeNull();
    expect(document.getElementById('dmermaid-orphan-x')).toBeNull();
  });

  it('is a no-op when no mermaid nodes exist', () => {
    expect(() => sweepOrphanMermaidNodes(__internalActiveRenderIds)).not.toThrow();
  });
});
describe('ACTIVE_RENDER_IDS race simulation — concurrent mounts', () => {
  // Models the exact scenario from the bug report: N MermaidBlocks mount in
  // the same tick. Each "block" runs:
  //   1. add(myId)
  //   2. attach measurement node `d<myId>`
  //   3. (microtask) sibling sweeps run here — must NOT remove our node
  //   4. delete(myId) (in our finally)
  //   5. attempt to remove our own measurement node
  //
  // We run the sweeps interleaved between steps 2 and 3 of each block.

  it('a sibling sweepBroad during another block mid-render leaves siblings node intact', () => {
    // Block A: just added itself, attached measurement div, NOT yet finished.
    __internalActiveRenderIds.add('mermaid-A-1');
    makeMermaidNode('dmermaid-A-1');

    // Block B: mounts now, runs its pre-render sweepBroad.
    __internalActiveRenderIds.add('mermaid-B-2');
    makeMermaidNode('dmermaid-B-2');
    sweepOrphanMermaidNodes(__internalActiveRenderIds); // B's sweep

    // Block A's measurement node MUST still exist — the bug was that this
    // sweep removed it, causing mermaid's `root.select(...).node()` lookup
    // after the microtask to return null.
    expect(document.getElementById('dmermaid-A-1')).not.toBeNull();
    expect(document.getElementById('dmermaid-B-2')).not.toBeNull();

    // Now block A finishes — it deletes itself and its measurement div.
    __internalActiveRenderIds.delete('mermaid-A-1');
    document.getElementById('dmermaid-A-1')?.remove();

    // And a leaked stale node from a previous failed render appears.
    makeMermaidNode('dmermaid-stale-99');

    // Block B's *cleanup* sweep (after it deletes itself in finally) should
    // remove the stale orphan but not affect anything currently active.
    __internalActiveRenderIds.delete('mermaid-B-2');
    document.getElementById('dmermaid-B-2')?.remove();
    sweepOrphanMermaidNodes(__internalActiveRenderIds);

    expect(document.getElementById('dmermaid-stale-99')).toBeNull();
    expect(__internalActiveRenderIds.size).toBe(0);
  });

  it('cleans up all leaks once every block has finished', () => {
    // Three blocks all leaked measurement divs (e.g. simultaneous syntax errors).
    makeMermaidNode('dmermaid-leak-1');
    makeMermaidNode('dmermaid-leak-2');
    makeMermaidNode('dmermaid-leak-3');
    // No active ids — nothing in flight.
    sweepOrphanMermaidNodes(__internalActiveRenderIds);

    expect(document.querySelectorAll('body > [id^="dmermaid-"]')).toHaveLength(0);
  });
});
