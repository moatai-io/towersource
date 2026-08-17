/**
 * Owns: 스크롤 요소 resolver 와 path 를 받아 위치를 자동 저장/복원.
 *
 * Public API: useScrollMemory(resolveEl, path)
 *   - resolveEl: () => HTMLElement | null — 매번 호출돼 *현재* 스크롤 요소를
 *     반환. 마운트 직후엔 null 일 수 있음 (iframe 로드 대기 / CodeMirror 초기화
 *     / async render 등). 요소가 잡힐 때까지 rAF 로 최대 ~1s 재시도.
 *   - path 가 바뀌면 이전 path 의 최종 위치를 flush 한 뒤 새 path 로 재바인딩.
 *   - 사용자 스크롤은 throttled (~250ms) 로 저장, unmount 시 즉시 flush.
 *
 * Resolver 패턴인 이유:
 *   - markdown: () => containerRef.current               (DOM mount 시 즉시 존재)
 *   - code:     () => wrapperRef.current?.querySelector('.cm-scroller')  (CodeMirror 가 늦게 만듦)
 *   - html:     () => wrapperRef.current?.querySelector('iframe')
 *                       ?.contentDocument?.scrollingElement              (iframe load 후 접근 가능)
 *   세 케이스를 한 hook 으로.
 *
 * 결정 근거: workspace/decisions/2026-05-22-global-multi-tab-shell.md (§ v3 후속)
 */
import { useEffect, useRef } from 'react';
import { getScrollPos, setScrollPos } from '../utils/scroll-memory';

const SAVE_THROTTLE_MS = 250;
const RESTORE_RETRY_FRAMES = 10;       // ~160ms — 콘텐츠 layout 안정화
const FIND_RETRY_FRAMES = 60;          // ~1s — iframe load / CodeMirror init 대기

type Resolver = () => HTMLElement | null;

export function useScrollMemory(resolveEl: Resolver, path: string | null) {
  // resolveEl 은 매 렌더마다 새 함수일 수 있음. ref 로 latest 보관 → useEffect
  // deps 는 [path] 만. 무한 re-bind 회피.
  const resolveRef = useRef(resolveEl);
  resolveRef.current = resolveEl;

  const pendingPos = useRef<number>(0);
  const lastSavedAt = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!path) return;

    let cancelled = false;
    let findRaf = 0;
    let restoreRaf = 0;
    let attachedEl: HTMLElement | null = null;
    let onScroll: (() => void) | null = null;

    const flush = () => {
      if (path) setScrollPos(path, pendingPos.current);
      lastSavedAt.current = Date.now();
      saveTimer.current = null;
    };

    const attachListener = (el: HTMLElement) => {
      onScroll = () => {
        pendingPos.current = el.scrollTop;
        const now = Date.now();
        if (now - lastSavedAt.current >= SAVE_THROTTLE_MS) {
          flush();
        } else if (!saveTimer.current) {
          saveTimer.current = setTimeout(flush, SAVE_THROTTLE_MS);
        }
      };
      el.addEventListener('scroll', onScroll, { passive: true });
      attachedEl = el;
    };

    const restoreThenAttach = (el: HTMLElement) => {
      const target = getScrollPos(path);
      if (target != null && target > 0) {
        // Reset then rAF-retry — content (markdown images, CodeMirror gutters,
        // iframe body) may still be laying out so scrollHeight grows over a few
        // frames before scrollTop can reach the target.
        el.scrollTop = 0;
        let frames = 0;
        const tryRestore = () => {
          if (cancelled || !attachedEl) return;
          attachedEl.scrollTop = target;
          frames++;
          if (frames < RESTORE_RETRY_FRAMES) {
            restoreRaf = requestAnimationFrame(tryRestore);
          }
        };
        restoreRaf = requestAnimationFrame(tryRestore);
      }
      attachListener(el);
    };

    let findFrames = 0;
    const tryFind = () => {
      if (cancelled) return;
      const el = resolveRef.current();
      if (el) {
        restoreThenAttach(el);
        return;
      }
      findFrames++;
      if (findFrames < FIND_RETRY_FRAMES) {
        findRaf = requestAnimationFrame(tryFind);
      }
      // Give up silently — viewer never produced a scrollable element
      // (e.g., cross-origin iframe). No throw.
    };

    findRaf = requestAnimationFrame(tryFind);

    return () => {
      cancelled = true;
      if (findRaf) cancelAnimationFrame(findRaf);
      if (restoreRaf) cancelAnimationFrame(restoreRaf);
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (attachedEl && onScroll) {
        attachedEl.removeEventListener('scroll', onScroll);
      }
      // Final flush — but only if we actually attached (pendingPos meaningful).
      // Otherwise we'd write 0 over a real saved value.
      if (attachedEl) setScrollPos(path, pendingPos.current);
    };
  }, [path]);
}
