import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/*
 * Owns: 입력창 textarea 의 사용자 드래그 리사이즈 핸들.
 * Public API: <InputResizeHandle onResize onReset />
 *
 * Tower 입력창은 두 가지 height 모드:
 *   - auto (default): scrollHeight 까지 자동 확장, 시스템 max-h 캡까지
 *   - manual: 사용자가 이 핸들로 드래그한 높이로 고정 (localStorage 저장)
 *
 * 더블클릭 → onReset 호출 → auto 모드 복귀.
 * 모바일 (<640px) 에선 InputBox 가 이 컴포넌트를 렌더하지 않음
 * — 모바일은 전체화면 토글 버튼으로 대체.
 *
 * 패턴은 layout/ResizeHandle.tsx 와 동일 (pointer capture + body cursor lock).
 * 차이점: row-resize (↑↓), height 만 계산.
 */
interface InputResizeHandleProps {
  /** 현재 textarea 높이 (px) — 드래그 시작점 측정용 */
  currentHeight: number;
  /** 드래그 중 새 높이 적용 */
  onResize: (heightPx: number) => void;
  /** 더블클릭 — auto 모드 복귀 */
  onReset: () => void;
  /** 사용자가 manual height 를 설정한 상태인지 (시각적 강조) */
  isManual: boolean;
}

const MIN_HEIGHT = 80;   // 너무 작으면 한 줄도 안 보임
const MAX_HEIGHT = 800;  // 그 이상은 풀스크린이 더 자연스러움

export function InputResizeHandle({
  currentHeight,
  onResize,
  onReset,
  isManual,
}: InputResizeHandleProps) {
  const { t } = useTranslation('chat');
  const dragging = useRef(false);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const startY = e.clientY;
    const startHeight = currentHeight;

    const handlePointerMove = (ev: PointerEvent) => {
      if (!dragging.current) return;
      // Drag UP = grow (textarea bottom is fixed, top expands)
      const delta = startY - ev.clientY;
      const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight + delta));
      onResize(next);
    };

    const handlePointerUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }, [currentHeight, onResize]);

  return (
    <div
      className="group relative h-2 -mb-1 cursor-row-resize touch-none select-none"
      onPointerDown={handlePointerDown}
      onDoubleClick={onReset}
      title={isManual ? t('inputResize.manualHint') : t('inputResize.hint')}
      aria-label={t('inputResize.label')}
    >
      {/* Hairline — 평소엔 거의 안 보이고, 호버 / 사용자 manual 상태에서 강조 */}
      <div
        className={`absolute top-1 left-1/2 -translate-x-1/2 h-0.5 rounded-full transition-all
          ${isManual
            ? 'w-12 bg-primary-500/40 group-hover:bg-primary-400/60'
            : 'w-8 bg-surface-600/40 group-hover:w-12 group-hover:bg-primary-400/50'}
        `}
      />
    </div>
  );
}

export { MIN_HEIGHT as INPUT_MIN_HEIGHT, MAX_HEIGHT as INPUT_MAX_HEIGHT };
