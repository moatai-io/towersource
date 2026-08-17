import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import mermaid from 'mermaid';
import { useSettingsStore } from '../../stores/settings-store';
import { isChunkLoadError, recoverFromChunkLoadError } from '../../utils/app-version';

let currentTheme: string | null = null;

/**
 * Module-level registry of renderIds belonging to MermaidBlock effects that
 * are *currently* running mermaid.render() (or about to). The broad orphan
 * sweep uses this to *skip* measurement divs that belong to a sibling block —
 * deleting those would break mermaid v11's microtask flow inside
 * `await Diagram.fromText()`, where mermaid attaches `<div id="dmermaid-…">`
 * to <body>, hands control off, then calls `root.select(enclosingDivID)` to
 * find it again. If our sweep runs in that gap and removes the sibling's div,
 * the .node() lookup returns null → "Cannot read properties of null
 * (reading 'firstChild')" crash.
 *
 * Lifecycle: add at the top of an effect run, delete in cleanup + finally.
 *
 * Exported (`__internalActiveRenderIds`) only for unit tests.
 */
const ACTIVE_RENDER_IDS = new Set<string>();

/** @internal — exported for vitest only. Do not import from app code. */
export const __internalActiveRenderIds = ACTIVE_RENDER_IDS;

/**
 * Given an element id like `dmermaid-abc-123` or `mermaid-abc-123`, return the
 * mermaid renderId portion (without the optional leading `d` measurement
 * prefix) — or `null` if it doesn't look like a mermaid id at all.
 *
 * mermaid v11 attaches the measurement div as `d<renderId>` (the leading `d`
 * is the prefix it uses internally). The final SVG container uses the
 * renderId verbatim. Both share the `mermaid-` infix, so we strip the
 * optional leading `d` to recover the renderId tracked by `ACTIVE_RENDER_IDS`.
 */
export function extractRenderIdFromMermaidNode(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id.startsWith('dmermaid-')) return id.slice(1); // drop leading 'd'
  if (id.startsWith('mermaid-')) return id;
  return null;
}

/**
 * Remove leaked mermaid measurement divs from <body> that do *not* belong to
 * any currently-active MermaidBlock effect (per `ACTIVE_RENDER_IDS`). Safe to
 * call from any block — won't touch a sibling's in-flight measurement node.
 *
 * Exported for unit tests; the production call sites are inside
 * `MermaidBlock`'s effect.
 */
export function sweepOrphanMermaidNodes(activeIds: Set<string> = ACTIVE_RENDER_IDS) {
  if (typeof document === 'undefined') return;
  const nodes = document.querySelectorAll('body > [id^="dmermaid-"], body > [id^="mermaid-"]');
  nodes.forEach((n) => {
    const renderId = extractRenderIdFromMermaidNode(n.id);
    // Unknown id format → leave alone (defensive).
    if (!renderId) return;
    // Belongs to a sibling block currently mid-render → leave alone.
    if (activeIds.has(renderId)) return;
    n.remove();
  });
}

/**
 * Tower Mermaid Theme — Linear-inspired minimalism
 *
 * 원칙 (한 비전, 전 다이어그램 공유):
 *   1. 3색 팔레트 — bg / fg / accent 1개. 끝.
 *      (crit 빨강만 간트 critical task에 예외)
 *   2. 아웃라인 우선 — 노드는 투명에 가까운 액센트 틴트 + 테두리가 주인공
 *   3. 시퀀스만 예외 — inverse-actor (fg 배경 + bg 글씨)로 시각적 포인트
 *   4. 파이/마인드맵 "무지개 금지" — 단일 accent의 명도 단계만 사용
 *   5. Pretendard 500 + letter-spacing -0.01em (타이포그래피가 주인공)
 *   6. Accent는 앱의 calm teal 브랜드 톤과 맞춘다. Blue는 info semantic에만 남긴다.
 *
 * 참고 미감: Linear / Stripe docs / Vercel docs
 */

/** hex 두 색을 혼합. bgWeight 1.0 = 전부 bg, 0.0 = 전부 fg */
function mix(bg: string, fg: string, bgWeight: number): string {
  const parse = (hex: string): [number, number, number] => {
    const h = hex.replace('#', '');
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  };
  const [br, bgG, bb] = parse(bg);
  const [fr, fgG, fb] = parse(fg);
  const blend = (a: number, b: number) =>
    Math.round(a * bgWeight + b * (1 - bgWeight));
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return '#' + toHex(blend(br, fr)) + toHex(blend(bgG, fgG)) + toHex(blend(bb, fb));
}

/** Linear-inspired: bg + fg + 1 accent. That's it. */
function buildMermaidTheme(mode: 'dark' | 'light') {
  const p = mode === 'dark'
    ? {
        bg:     '#071012',  // Tower dark surface
        fg:     '#edf7f6',  // cool white, shared with app theme
        accent: '#14b8a6',  // calm teal — Tower brand accent
        crit:   '#f87171',  // red-400 — gantt critical만
      }
    : {
        bg:     '#ffffff',
        fg:     '#0f172a',
        accent: '#0d9488',  // calm teal — Tower light accent
        crit:   '#dc2626',  // red-600
      };

  const { bg, fg, accent, crit } = p;

  // 파생 — 모두 accent 또는 fg 한쪽으로만 밀기
  const nodeFill    = mix(bg, accent, 0.94);  // 아주 옅은 액센트 틴트
  const nodeFill2   = mix(bg, accent, 0.90);
  const nodeFill3   = mix(bg, accent, 0.86);
  const nodeStroke  = mix(bg, accent, 0.45);  // 중간 강도 블루 (테두리 주인공)
  const subtle      = mix(bg, fg, 0.82);      // 클러스터 테두리 — 거의 안 보일 정도
  const muted       = mix(bg, fg, 0.60);      // 중간 회색 (sequence 보조)
  const edge        = mix(bg, fg, 0.70);      // 엣지 — 뚜렷하지만 조용하게

  return {
    theme: 'base' as const,
    themeVariables: {
      // ── Core ──
      primaryColor: nodeFill,
      primaryBorderColor: nodeStroke,
      primaryTextColor: fg,
      secondaryColor: nodeFill2,
      secondaryBorderColor: nodeStroke,
      secondaryTextColor: fg,
      tertiaryColor: nodeFill3,
      tertiaryBorderColor: nodeStroke,
      tertiaryTextColor: fg,

      // ── Flowchart / general ──
      // background는 실제 bg로 (ER attribute 파생 계산 안정화, CSS에서 시각적 투명 처리)
      background: bg,
      mainBkg: nodeFill,
      nodeBorder: nodeStroke,
      nodeTextColor: fg,
      clusterBkg: bg,          // cluster는 CSS에서 완전 투명 + dashed outline
      clusterBorder: subtle,
      defaultLinkColor: edge,
      lineColor: edge,
      edgeLabelBackground: bg,
      titleColor: fg,
      textColor: fg,
      labelColor: fg,
      altBackground: bg,

      // ── Sequence — inverse-actor (유일한 시각적 포인트) ──
      actorBkg: fg,
      actorBorder: fg,
      actorTextColor: bg,
      actorLineColor: muted,
      signalColor: fg,
      signalTextColor: fg,
      labelBoxBkgColor: bg,    // alt/opt/loop — 투명하게 CSS에서 처리
      labelBoxBorderColor: muted,
      labelTextColor: fg,
      loopTextColor: fg,
      noteBkgColor: bg,        // note — 투명 + 뉴트럴 테두리만
      noteTextColor: fg,
      noteBorderColor: muted,

      // ── ER — 행 배경 통일 (교차 컬러 없음) ──
      // 최신 mermaid는 rowOdd/rowEven 토큰을 사용. 구 attributeBackgroundColor* 도 호환용으로 유지.
      rowOdd: bg,
      rowEven: bg,
      attributeBackgroundColorOdd: bg,
      attributeBackgroundColorEven: bg,

      // ── Gantt — accent 1색 + opacity 단계 (crit만 빨강) ──
      sectionBkgColor: mix(bg, fg, 0.96),   // 섹션 배경 살짝 가시
      altSectionBkgColor: bg,
      sectionBkgColor2: mix(bg, fg, 0.96),
      taskBkgColor: mix(bg, accent, 0.70),  // pending — 더 진한 액센트 틴트
      taskBorderColor: accent,
      doneTaskBkgColor: mix(bg, fg, 0.85),  // done — 살짝 대비 있는 회색
      doneTaskBorderColor: mix(bg, fg, 0.65),
      activeTaskBkgColor: accent,           // active — 풀 액센트
      activeTaskBorderColor: accent,
      critBkgColor: mix(bg, crit, 0.80),    // crit — 유일 예외
      critBorderColor: crit,
      gridColor: mix(bg, fg, 0.88),
      todayLineColor: mix(bg, fg, 0.50),    // today 선 — 뉴트럴 중간 회색 (빨강 금지)
      taskTextColor: fg,
      taskTextLightColor: fg,
      taskTextDarkColor: bg,
      taskTextOutsideColor: fg,

      // ── Pie — 단일 accent의 명도 단계 + 뉴트럴 보조 (무지개 금지) ──
      pie1: accent,                         // 100% accent
      pie2: mix(bg, accent, 0.40),          // 60%
      pie3: mix(bg, accent, 0.60),          // 40%
      pie4: mix(bg, accent, 0.78),          // 22%
      pie5: mix(bg, fg, 0.55),              // 중립 회색 시작
      pie6: mix(bg, fg, 0.70),
      pie7: mix(bg, fg, 0.82),
      pie8: mix(bg, fg, 0.90),
      pie9: accent,                         // 반복
      pie10: mix(bg, accent, 0.60),
      pie11: mix(bg, fg, 0.70),
      pie12: mix(bg, fg, 0.88),
      pieStrokeColor: bg,                   // 슬라이스 사이 = bg 동색 → 갭
      pieStrokeWidth: '2px',
      pieOuterStrokeWidth: '0px',           // outer ring 제거
      pieOpacity: '1',
      pieSectionTextColor: mode === 'dark' ? bg : fg,  // accent 배경 위 대비
      pieSectionTextSize: '13px',
      pieTitleTextColor: fg,
      pieTitleTextSize: '16px',
      pieLegendTextColor: fg,
      pieLegendTextSize: '12px',

      // ── Mindmap — 루트만 accent, 가지는 전부 뉴트럴 ──
      cScale0: accent,                      // 루트 = 유일한 포인트
      cScale1: mix(bg, fg, 0.78),
      cScale2: mix(bg, fg, 0.84),
      cScale3: mix(bg, fg, 0.90),
      cScale4: mix(bg, fg, 0.93),
      cScale5: mix(bg, fg, 0.78),
      cScale6: mix(bg, fg, 0.84),
      cScale7: mix(bg, fg, 0.90),
      cScale8: mix(bg, fg, 0.93),
      cScale9: mix(bg, fg, 0.84),
      cScale10: mix(bg, fg, 0.90),
      cScale11: mix(bg, fg, 0.93),
      cScalePeer0: accent,
      cScalePeer1: muted,
      cScalePeer2: muted,
      cScalePeer3: muted,
      cScalePeer4: muted,
      cScalePeer5: muted,
      cScalePeer6: muted,
      cScalePeer7: muted,
      cScaleLabel0: mode === 'dark' ? bg : '#ffffff',  // 루트는 흰/검 텍스트
      cScaleLabel1: fg, cScaleLabel2: fg, cScaleLabel3: fg,
      cScaleLabel4: fg, cScaleLabel5: fg, cScaleLabel6: fg, cScaleLabel7: fg,

      // ── Typography ──
      fontFamily: '"Pretendard Variable", Pretendard, Inter, -apple-system, BlinkMacSystemFont, sans-serif',
      fontSize: '14px',
    },
    flowchart: {
      padding: 24,
      nodeSpacing: 54,
      rankSpacing: 68,
      htmlLabels: true,
      wrappingWidth: 220,
      curve: 'basis' as const,
    },
    sequence: {
      boxMargin: 14,
      noteMargin: 14,
      messageMargin: 42,
    },
    gantt: {
      barHeight: 28,           // 18 → 28 — 읽기 편한 높이
      barGap: 8,               // 4 → 8 — 행 사이 숨쉴 여백
      topPadding: 60,
      leftPadding: 90,
      sidePadding: 40,
      fontSize: 13,            // 12 → 13
      sectionFontSize: 14,     // 13 → 14
      gridLineStartPadding: 35,
      titleTopMargin: 24,
      numberSectionStyles: 4,
    },
    pie: {
      textPosition: 0.6,
    },
  };
}

function ensureInit(theme: string) {
  const mode: 'dark' | 'light' = theme !== 'light' ? 'dark' : 'light';
  if (currentTheme !== mode) {
    const config = buildMermaidTheme(mode);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      ...config,
    });
    currentTheme = mode;
  }
}

/** djb2 hash — stable ID for mermaid render targets */
function hashCode(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// NOTE: 2026-05-09–10 시도했던 두 가지 무성 변환을 의도적으로 제거함:
//   - stripUserColorOverrides()  (사용자 `style/classDef fill:..., color:...` 자동 제거)
//   - normalizeEdgeSyntax()      (`-.x.->` → `-.-x` 등 자동 재작성)
// 이유 — 같은 source 가 두 source-of-truth (mermaid grammar + Tower 정상화기) 로
// 갈라지고, 사용자가 의도한 색상이 조용히 사라지는 게 디버깅을 망가뜨림. 시스템
// 프롬프트의 mermaid 가이드 (label quoting, EDGE END MARKERS, COLORS 금지) 가
// 정도. mermaid 가 던지는 파싱 에러는 그대로 노출 — AI 가 다음 턴 그 에러를 보고
// 자가 수정 가능. 근거: workspace/decisions/2026-05-10-mermaid-prompt-only-rollback.md
//
// 같은 시도를 다시 할 때 알아둘 점: code-level guard 는 사용자 의도 반영을 막고
// 사일런트 변환 사실을 숨겨 추후 디버깅을 어렵게 한다. 시스템 프롬프트 강화로
// 해결할 수 있는지 먼저 검토할 것.

/** Post-process SVG: set width=100%, preserve viewBox, prevent text clipping */
function patchSvgForFullWidth(svg: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  if (!svgEl) return svg;

  // Ensure viewBox exists (use width/height as fallback)
  if (!svgEl.getAttribute('viewBox')) {
    const w = parseFloat(svgEl.getAttribute('width') || '800');
    const h = parseFloat(svgEl.getAttribute('height') || '600');
    svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }

  // Expand viewBox slightly for padding (prevents edge clipping)
  const vb = svgEl.getAttribute('viewBox')!.split(' ').map(Number);
  const pad = 16;
  svgEl.setAttribute('viewBox', `${vb[0] - pad} ${vb[1] - pad} ${vb[2] + pad * 2} ${vb[3] + pad * 2}`);

  // Set responsive sizing
  svgEl.setAttribute('width', '100%');
  svgEl.removeAttribute('height');

  // Add overflow visible to prevent text clipping in nodes
  svgEl.style.overflow = 'visible';

  return new XMLSerializer().serializeToString(svgEl);
}

function downloadSvg(svg: string) {
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'diagram.svg';
  a.click();
  URL.revokeObjectURL(url);
}

async function downloadJpg(svgContent: string, theme?: string) {
  // Parse to get real dimensions from viewBox / width / height
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgContent, 'image/svg+xml');
  const svgEl = doc.querySelector('svg')!;

  let width = parseFloat(svgEl.getAttribute('width') || '0');
  let height = parseFloat(svgEl.getAttribute('height') || '0');
  const viewBox = svgEl.getAttribute('viewBox');
  if ((!width || !height) && viewBox) {
    const [, , vw, vh] = viewBox.split(' ').map(Number);
    width = vw || 800;
    height = vh || 600;
  }
  width = width || 800;
  height = height || 600;
  svgEl.setAttribute('width', String(width));
  svgEl.setAttribute('height', String(height));

  const blob = new Blob([new XMLSerializer().serializeToString(svgEl)], {
    type: 'image/svg+xml;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);

  const img = new Image();
  img.src = url;
  await new Promise<void>((resolve) => { img.onload = () => resolve(); });

  const scale = 2; // 2× for crisp JPG
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.fillStyle = theme === 'light' ? '#ffffff' : '#071012';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0);
  URL.revokeObjectURL(url);

  canvas.toBlob((b) => {
    if (!b) return;
    const jpgUrl = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = jpgUrl;
    a.download = 'diagram.jpg';
    a.click();
    URL.revokeObjectURL(jpgUrl);
  }, 'image/jpeg', 0.95);
}

/* ── Diagram Canvas Lightbox ── */

type SvgMetrics = {
  width: number;
  height: number;
  viewBox: [number, number, number, number];
};

function readSvgMetrics(svg: string): SvgMetrics {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  const fallback: SvgMetrics = { width: 800, height: 600, viewBox: [0, 0, 800, 600] };
  if (!svgEl) return fallback;

  const viewBoxRaw = svgEl.getAttribute('viewBox');
  const viewBox = viewBoxRaw?.trim().split(/[\s,]+/).map(Number) ?? [];
  const parseAbsoluteLength = (value: string | null) => {
    if (!value || value.trim().endsWith('%')) return 0;
    return parseFloat(value) || 0;
  };
  const width = parseAbsoluteLength(svgEl.getAttribute('width'));
  const height = parseAbsoluteLength(svgEl.getAttribute('height'));
  const vbWidth = viewBox[2] || width || fallback.width;
  const vbHeight = viewBox[3] || height || fallback.height;

  return {
    width: width || vbWidth,
    height: height || vbHeight,
    viewBox: [viewBox[0] || 0, viewBox[1] || 0, vbWidth, vbHeight],
  };
}

function makeSvgFixedSize(svg: string, metrics: SvgMetrics): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  if (!svgEl) return svg;

  svgEl.setAttribute('width', String(metrics.width));
  svgEl.setAttribute('height', String(metrics.height));
  svgEl.setAttribute('viewBox', metrics.viewBox.join(' '));
  svgEl.style.maxWidth = 'none';
  svgEl.style.overflow = 'visible';
  svgEl.style.display = 'block';

  return new XMLSerializer().serializeToString(svgEl);
}

function MermaidLightbox({ svgContent, onClose }: { svgContent: string; onClose: () => void }) {
  const metrics = useMemo(() => readSvgMetrics(svgContent), [svgContent]);
  const canvasSvg = useMemo(() => makeSvgFixedSize(svgContent, metrics), [svgContent, metrics]);
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [viewMode, setViewMode] = useState<'fit' | 'free'>('fit');
  const [spaceDown, setSpaceDown] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const posAtDragStart = useRef({ x: 0, y: 0 });
  const minimapDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);

  const clampScale = useCallback((s: number) => Math.min(Math.max(s, 0.05), 8), []);

  const fitToView = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const safeWidth = Math.max(rect.width - 96, 160);
    const safeHeight = Math.max(rect.height - 96, 120);
    const nextScale = clampScale(Math.min(safeWidth / metrics.width, safeHeight / metrics.height));
    setScale(nextScale);
    setPos({ x: 0, y: 0 });
    setViewMode('fit');
  }, [clampScale, metrics.height, metrics.width]);

  const setActualSize = useCallback(() => {
    setScale(1);
    setPos({ x: 0, y: 0 });
    setViewMode('free');
  }, []);

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cursorX = clientX - rect.left - rect.width / 2;
    const cursorY = clientY - rect.top - rect.height / 2;
    const newScale = clampScale(scale * factor);
    if (newScale === scale) return;
    const ratio = 1 - newScale / scale;
    setScale(newScale);
    setViewMode('free');
    setPos(p => ({ x: p.x + (cursorX - p.x) * ratio, y: p.y + (cursorY - p.y) * ratio }));
  }, [clampScale, scale]);

  const zoomFromCenter = useCallback((factor: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }, [zoomAt]);

  useEffect(() => {
    const id = requestAnimationFrame(fitToView);
    return () => cancelAnimationFrame(id);
  }, [fitToView]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setViewportSize({ width: rect.width, height: rect.height });
      if (viewMode === 'fit') requestAnimationFrame(fitToView);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, [fitToView, viewMode]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === '0') {
        e.preventDefault();
        fitToView();
      } else if (e.key === '1') {
        e.preventDefault();
        setActualSize();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomFromCenter(1.2);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomFromCenter(1 / 1.2);
      } else if (e.key === ' ') {
        e.preventDefault();
        setSpaceDown(true);
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        setViewMode('free');
        const step = e.shiftKey ? 160 : 80;
        setPos(p => ({
          x: p.x + (e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0),
          y: p.y + (e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0),
        }));
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpaceDown(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [fitToView, onClose, setActualSize, zoomFromCenter]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.16 : 1 / 1.16);
      return;
    }

    setViewMode('free');
    setPos(p => ({
      x: p.x - (e.shiftKey ? e.deltaY : e.deltaX),
      y: p.y - (e.shiftKey ? 0 : e.deltaY),
    }));
  }, [zoomAt]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY };
    posAtDragStart.current = { ...pos };
    setViewMode('free');
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [pos]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    setPos({
      x: posAtDragStart.current.x + (e.clientX - dragStart.current.x),
      y: posAtDragStart.current.y + (e.clientY - dragStart.current.y),
    });
  }, []);

  const handlePointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    zoomAt(e.clientX, e.clientY, 1.8);
  }, [zoomAt]);

  const minimapScale = Math.min(168 / metrics.width, 108 / metrics.height, 1);
  const minimapWidth = metrics.width * minimapScale;
  const minimapHeight = metrics.height * minimapScale;
  const visibleWidth = viewportSize.width / scale;
  const visibleHeight = viewportSize.height / scale;
  const visibleX = metrics.width / 2 + (-viewportSize.width / 2 - pos.x) / scale;
  const visibleY = metrics.height / 2 + (-viewportSize.height / 2 - pos.y) / scale;
  const minimapRect = {
    left: Math.max(0, Math.min(minimapWidth, visibleX * minimapScale)),
    top: Math.max(0, Math.min(minimapHeight, visibleY * minimapScale)),
    width: Math.max(8, Math.min(minimapWidth, visibleWidth * minimapScale)),
    height: Math.max(8, Math.min(minimapHeight, visibleHeight * minimapScale)),
  };

  const centerFromMinimap = useCallback((clientX: number, clientY: number) => {
    const rect = minimapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const contentX = ((clientX - rect.left) / minimapScale) - metrics.width / 2;
    const contentY = ((clientY - rect.top) / minimapScale) - metrics.height / 2;
    setViewMode('free');
    setPos({ x: -contentX * scale, y: -contentY * scale });
  }, [metrics.height, metrics.width, minimapScale, scale]);

  const btnClass = "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-surface-700/60 bg-surface-850/95 px-2 text-[13px] font-medium text-gray-300 shadow-sm transition-all hover:border-surface-600 hover:bg-surface-800 hover:text-gray-100";
  const iconBtnClass = "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-surface-700/60 bg-surface-850/95 text-gray-300 shadow-sm transition-all hover:border-surface-600 hover:bg-surface-800 hover:text-gray-100";

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div
        className="absolute inset-3 md:inset-6 overflow-hidden rounded-2xl border border-surface-700/60 bg-surface-950 shadow-2xl"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Diagram viewer"
      >
        {/* Top toolbar */}
        <div className="absolute left-3 right-3 top-3 z-20 flex flex-wrap items-center justify-between gap-2 pointer-events-none">
          <div className="flex items-center gap-1.5 pointer-events-auto rounded-xl border border-surface-700/50 bg-surface-950/80 p-1 shadow-xl backdrop-blur-md">
            <button onClick={fitToView} className={btnClass} title="Fit to screen (0)">
              Fit
            </button>
            <button onClick={setActualSize} className={btnClass} title="Actual size (1)">
              100%
            </button>
            <div className="mx-1 h-5 w-px bg-surface-700/60" />
            <button onClick={() => zoomFromCenter(1 / 1.2)} className={iconBtnClass} title="Zoom out (-)">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM7 10h6" />
              </svg>
            </button>
            <input
              aria-label="Zoom"
              className="h-1.5 w-28 accent-blue-400"
              min="0.05"
              max="8"
              step="0.01"
              type="range"
              value={scale}
              onChange={(e) => {
                setScale(Number(e.target.value));
                setViewMode('free');
              }}
            />
            <button onClick={() => zoomFromCenter(1.2)} className={iconBtnClass} title="Zoom in (+)">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6m3-3H7" />
              </svg>
            </button>
            <span className="min-w-[3.75rem] select-none text-center text-[13px] tabular-nums text-gray-400">
              {Math.round(scale * 100)}%
            </span>
          </div>

          <button onClick={onClose} className={`${iconBtnClass} pointer-events-auto`} title="Close (Esc)">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Canvas */}
        <div
          ref={containerRef}
          className={`h-full w-full select-none ${spaceDown ? 'cursor-grab' : 'cursor-move'} active:cursor-grabbing`}
          style={{ touchAction: 'none' }}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={handleDoubleClick}
        >
          <div
            className="flex h-full w-full items-center justify-center [&_svg]:max-w-none [&_svg]:overflow-visible"
            style={{
              transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
              transformOrigin: 'center center',
              transition: dragging.current ? 'none' : 'transform 90ms ease-out',
            }}
            dangerouslySetInnerHTML={{ __html: canvasSvg }}
          />
        </div>

        {/* Minimap */}
        <div className="absolute bottom-4 left-4 z-20 hidden rounded-xl border border-surface-700/60 bg-surface-950/85 p-2 shadow-xl backdrop-blur-md md:block">
          <div
            ref={minimapRef}
            className="relative cursor-crosshair overflow-hidden rounded-md bg-surface-900/70"
            style={{ width: minimapWidth, height: minimapHeight }}
            onPointerDown={(e) => {
              minimapDragging.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              centerFromMinimap(e.clientX, e.clientY);
            }}
            onPointerMove={(e) => {
              if (minimapDragging.current) centerFromMinimap(e.clientX, e.clientY);
            }}
            onPointerUp={() => { minimapDragging.current = false; }}
            onPointerCancel={() => { minimapDragging.current = false; }}
          >
            <div
              className="origin-top-left opacity-65 [&_svg]:max-w-none"
              style={{ transform: `scale(${minimapScale})`, width: metrics.width, height: metrics.height }}
              dangerouslySetInnerHTML={{ __html: canvasSvg }}
            />
            <div
              className="absolute rounded-sm border border-blue-300/90 bg-blue-400/15 shadow-[0_0_0_999px_rgba(2,6,23,0.18)]"
              style={minimapRect}
            />
          </div>
        </div>

        {/* Hint */}
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 hidden -translate-x-1/2 select-none rounded-full border border-surface-700/50 bg-surface-950/75 px-3 py-1.5 text-[13px] text-gray-500 shadow-lg backdrop-blur-md lg:block">
          Drag: move · Wheel: pan · Ctrl/Cmd+Wheel: zoom · 0: fit · 1: 100% · Esc: close
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface MermaidBlockProps {
  code: string;
}

export const MermaidBlock = React.memo(function MermaidBlock({ code }: MermaidBlockProps) {
  const [svgContent, setSvgContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const theme = useSettingsStore((s) => s.theme);
  const idRef = useRef(`mermaid-${hashCode(code)}-${Date.now()}`);
  const rawSvgRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Generate a fresh ID for each render to avoid mermaid ID conflicts.
    // CRITICAL: capture renderId in the effect's closure (not via idRef) so
    // that sweep + render calls always reference *this* render's id, not a
    // stale value left behind by a subsequent re-run. (Earlier version used
    // idRef.current which gets overwritten when `code` changes — the cleanup
    // for the old render then ran sweep with the *new* id and missed the
    // real orphan, leaking <div id="dmermaid-…"> right above the footer.)
    const renderId = `mermaid-${hashCode(code)}-${Date.now()}`;
    idRef.current = renderId;

    /**
     * Sweep mermaid's leftover measurement elements from <body>.
     * mermaid v10/v11 attaches a hidden `<div id="dmermaid-…">` (and
     * sometimes the same id without the leading 'd') to <body> for SVG
     * measurement. On render success it removes them — but on syntax-error
     * throw it can leak. Once they pile up, layout reflow exposes them as a
     * stray gray strip just above the footer.
     *
     * Two-tier sweep:
     *   1. Exact match for *this* render's id (closure-captured) — always
     *      safe because we own this id.
     *   2. Broad fallback — every `body > [id^="dmermaid-"]` whose renderId
     *      is *not* in `ACTIVE_RENDER_IDS`. This skips measurement divs
     *      currently being used by a sibling MermaidBlock (mermaid v11
     *      relies on them across an `await Diagram.fromText()` microtask
     *      boundary; deleting them mid-flight crashes with
     *      `Cannot read properties of null (reading 'firstChild')`).
     */
    const sweepThisRender = () => {
      document
        .querySelectorAll(`body > [id="d${renderId}"], body > [id="${renderId}"]`)
        .forEach((n) => n.remove());
    };
    const sweepBroad = () => {
      sweepOrphanMermaidNodes(ACTIVE_RENDER_IDS);
    };

    // Register *before* sweepBroad runs so concurrent siblings' broad sweeps
    // don't see this renderId as orphan. (sweepBroad below also reads from
    // ACTIVE_RENDER_IDS so we're protected from our own future sweeps too.)
    ACTIVE_RENDER_IDS.add(renderId);

    async function render() {
      ensureInit(theme);
      sweepThisRender(); // Pre-clean any leftovers from a previous attempt
      sweepBroad();      // Nuke stale orphans (skips active siblings)
      try {
        // 폰트 로딩 대기 — mermaid는 측정(DOM)과 렌더(SVG) 시점의 폰트가 다르면 노드 폭을 잘못 계산해 텍스트가 박스 밖으로 튀어나감.
        // Pretendard가 늦게 로드되면 시스템 fallback으로 측정 → Pretendard로 렌더 → 오버플로 발생.
        // 이미 로드됐으면 즉시 resolved 프로미스라 비용 없음.
        if (typeof document !== 'undefined' && 'fonts' in document) {
          await document.fonts.ready;
        }
        // No pre-render transformation. mermaid grammar = source of truth.
        // System prompt guidance (label quoting / EDGE END MARKERS / COLORS)
        // is the supported channel for shaping AI output. If parsing fails,
        // the user / AI sees the real mermaid error and can correct it next
        // turn. See workspace/decisions/2026-05-10-mermaid-prompt-only-rollback.md
        const { svg } = await mermaid.render(renderId, code);
        if (!cancelled) {
          rawSvgRef.current = svg; // Keep original for downloads
          const processed = patchSvgForFullWidth(svg);
          setSvgContent(processed);
          if (error !== null) setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? (e.message || 'Render failed') : (String(e) || 'Mermaid render error');
          // Mermaid loads individual diagram implementations with internal dynamic imports.
          // After a deploy, an already-open tab can request an old hashed diagram chunk;
          // the SPA fallback answers with index.html, which browsers report as an invalid
          // JavaScript MIME type. This is an app-version mismatch, not Mermaid syntax.
          if (isChunkLoadError(e) && recoverFromChunkLoadError()) return;
          console.error('[Mermaid] render error:', msg, e);
          setError(msg);
        }
        sweepThisRender(); // Always sweep on failure regardless of cancellation
        sweepBroad();
      } finally {
        // Render is done (success or failure). Drop registration so a future
        // sweepBroad — ours or a sibling's — can clean up our own leftovers.
        ACTIVE_RENDER_IDS.delete(renderId);
      }
    }

    render();
    return () => {
      cancelled = true;
      // Unmount / code change — drop registration immediately so cleanup
      // sweep can collect any leftover measurement div this effect created.
      ACTIVE_RENDER_IDS.delete(renderId);
      sweepThisRender(); // Clean on unmount / code change too
      sweepBroad();      // Belt + suspenders for already-orphaned siblings
    };
  }, [code, theme]);

  const handleDownloadSvg = useCallback(() => {
    const raw = rawSvgRef.current;
    if (raw) downloadSvg(raw);
  }, []);

  const handleDownloadJpg = useCallback(() => {
    const raw = rawSvgRef.current;
    if (raw) downloadJpg(raw, theme);
  }, [theme]);

  if (error) {
    return (
      <pre className="bg-surface-900/60 border border-surface-700/40 rounded-lg p-4 overflow-x-auto text-base">
        <code className="text-sm text-red-400 block mb-2">⚠ {error}</code>
        <code>{code}</code>
      </pre>
    );
  }

  if (!svgContent) {
    return (
      <div className="my-2 rounded-lg border border-surface-700/40 bg-surface-900/60 p-4 min-h-[120px] flex items-center justify-center">
        <div className="flex items-center gap-2 text-gray-500 text-base">
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Rendering diagram…
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="my-2 relative group/mermaid">
        {/* Toolbar — hover on desktop, always visible on touch */}
        <div className="absolute top-2 right-2 z-10 flex gap-1 opacity-0 group-hover/mermaid:opacity-100 transition-opacity">
          <button
            onClick={() => setExpanded(true)}
            className="p-1.5 rounded-md bg-surface-800/90 border border-surface-700/50 text-gray-400 hover:text-gray-200 hover:bg-surface-700/80 transition-all"
            title="Expand"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          </button>
          <button
            onClick={handleDownloadSvg}
            className="p-1.5 rounded-md bg-surface-800/90 border border-surface-700/50 text-gray-400 hover:text-gray-200 hover:bg-surface-700/80 transition-all"
            title="Download SVG"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <span className="sr-only">SVG</span>
          </button>
          <button
            onClick={handleDownloadJpg}
            className="p-1.5 rounded-md bg-surface-800/90 border border-surface-700/50 text-gray-400 hover:text-gray-200 hover:bg-surface-700/80 transition-all"
            title="Download JPG"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span className="sr-only">JPG</span>
          </button>
        </div>

        {/* Diagram — full width, horizontal scroll on mobile, fade-in on first render */}
        <div
          className="mermaid-wrapper w-full overflow-x-auto [&_svg]:max-w-none [&_svg]:overflow-visible"
          style={{ animation: 'fade-in-block 0.3s ease-out' }}
          dangerouslySetInnerHTML={{ __html: svgContent }}
        />
      </div>

      {/* Zoomable Lightbox */}
      {expanded && <MermaidLightbox svgContent={svgContent} onClose={() => setExpanded(false)} />}
    </>
  );
});
