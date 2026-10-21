// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeBottomLayout } from './observeBottomLayout';

function setup() {
  const element = document.createElement('div');
  element.appendChild(document.createElement('div'));
  document.body.appendChild(element);
  let height = 2000;
  let client = 600;
  Object.defineProperties(element, {
    scrollHeight: { get: () => height }, clientHeight: { get: () => client },
  });
  element.scrollTop = 1400;
  let resize!: () => void;
  const disconnect = vi.fn();
  const observed = new Set<Element>();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe(element: Element) { observed.add(element); } disconnect = disconnect;
  });
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  let pinned = true;
  const history = vi.fn(() => { pinned = false; });
  const cleanup = observeBottomLayout(element, () => pinned, history);
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(cb => cb(0)); };
  flush();
  return { element, observed, resize: () => resize(), flush, cleanup, history, frames, disconnect,
    setHeight: (value: number) => { height = value; },
    setClient: (value: number) => { client = value; },
    readHistory: () => { pinned = false; } };
}

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('observeBottomLayout', () => {
  it('observes a nested Virtuoso measured list, not just the fixed viewport', async () => {
    const h = setup();
    const list = document.createElement('div'); list.dataset.testid = 'virtuoso-item-list';
    h.element.firstElementChild!.appendChild(list);
    await Promise.resolve();
    expect(h.observed.has(list)).toBe(true); h.cleanup();
  });
  it('pins late intrinsic image growth without a React render', () => {
    const h = setup(); h.setHeight(2800); h.resize(); h.flush();
    expect(h.element.scrollTop).toBe(2200); expect(h.history).not.toHaveBeenCalled(); h.cleanup();
  });
  it('does not pull a history reader down, including intent acquired after scheduling', () => {
    const h = setup(); h.setHeight(2800); h.resize(); h.readHistory(); h.flush();
    expect(h.element.scrollTop).toBe(1400); h.cleanup();
  });
  it('cancels queued writes and ignores observer deliveries after disposal', () => {
    const h = setup(); h.setHeight(2800); h.resize(); h.cleanup(); h.resize(); h.flush();
    expect(h.element.scrollTop).toBe(1400); expect(h.frames.size).toBe(0); expect(h.disconnect).toHaveBeenCalled();
  });
  it('treats upward scrollbar dragging as history intent', () => {
    const h = setup(); h.element.dispatchEvent(new Event('pointerdown'));
    h.element.scrollTop = 1100; h.element.dispatchEvent(new Event('scroll'));
    expect(h.history).toHaveBeenCalledOnce(); h.setHeight(2800); h.resize(); h.flush();
    expect(h.element.scrollTop).toBe(1100); h.cleanup();
  });
  it('does not classify layout anchoring as a user drag', () => {
    const h = setup(); h.setHeight(2800); h.element.scrollTop = 1300;
    h.element.dispatchEvent(new Event('scroll')); h.resize(); h.flush();
    expect(h.history).not.toHaveBeenCalled(); expect(h.element.scrollTop).toBe(2200); h.cleanup();
  });
  it('preserves hidden geometry and re-pins after a viewport becomes visible', () => {
    const h = setup(); h.setClient(0); h.resize(); h.flush(); expect(h.element.scrollTop).toBe(1400);
    h.setClient(500); h.resize(); h.flush(); expect(h.element.scrollTop).toBe(1500); h.cleanup();
  });
});
