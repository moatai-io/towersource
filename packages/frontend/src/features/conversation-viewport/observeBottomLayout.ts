import { isNearBottom } from './scrollPositionMath';

/** Observe geometry, not user intent. Callers own the pinned/history policy. */
export function observeBottomLayout(
  scroller: HTMLElement,
  isPinned: () => boolean,
  onHistoryIntent: () => void,
) {
  let disposed = false;
  let frame = 0;
  let previousTop = scroller.scrollTop;
  let previousHeight = scroller.scrollHeight;
  let previousClientHeight = scroller.clientHeight;
  let pointerDown = false;
  const schedule = () => {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (disposed || !isPinned() || scroller.clientHeight === 0) return;
      const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (Math.abs(scroller.scrollTop - bottom) > 1) scroller.scrollTop = bottom;
      previousTop = scroller.scrollTop;
      previousHeight = scroller.scrollHeight;
      previousClientHeight = scroller.clientHeight;
    });
  };
  const onScroll = () => {
    // Scrollbar dragging has no wheel event. Do not confuse a height change or
    // a browser scroll-anchor adjustment with an intentional upward drag.
    if (pointerDown && scroller.scrollTop < previousTop - 1
      && scroller.scrollHeight === previousHeight && scroller.clientHeight === previousClientHeight
      && !isNearBottom(scroller, 80)) onHistoryIntent();
    previousTop = scroller.scrollTop;
    previousHeight = scroller.scrollHeight;
    previousClientHeight = scroller.clientHeight;
  };
  const onPointerDown = () => { pointerDown = true; };
  const onPointerUp = () => { pointerDown = false; };
  const resize = new ResizeObserver(schedule);
  let observed: Element[] = [];
  const observeChildren = () => {
    // Virtuoso's immediate viewport is fixed-height/absolute. Observe its
    // measured list as well, otherwise intrinsic image growth is invisible.
    const targets = [scroller, ...scroller.children, ...scroller.querySelectorAll('[data-testid="virtuoso-item-list"]')];
    if (targets.length === observed.length && targets.every((target, index) => target === observed[index])) return;
    resize.disconnect();
    observed = targets;
    targets.forEach(target => resize.observe(target));
  };
  const mutation = new MutationObserver(() => { observeChildren(); schedule(); });
  observeChildren();
  mutation.observe(scroller, { childList: true, subtree: true });
  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointerup', onPointerUp, { passive: true });
  window.addEventListener('pointercancel', onPointerUp, { passive: true });
  schedule();
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutation.disconnect();
    scroller.removeEventListener('scroll', onScroll);
    scroller.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
  };
}
