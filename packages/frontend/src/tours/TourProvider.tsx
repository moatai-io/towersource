import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getTourDefinition, type TourDefinition, type TourScene, type TourStep } from './tourRegistry';
import { markTourCompleted, markTowerGuideSeen } from './tourState';
import { useSessionStore } from '../stores/session-store';

interface TourContextValue {
  activeTour: TourDefinition | null;
  activeStep: TourStep | null;
  stepIndex: number;
  startTour: (tourId: string) => void;
  endTour: () => void;
  nextStep: () => void;
  previousStep: () => void;
}

const TourContext = createContext<TourContextValue | null>(null);

type RectLike = Pick<DOMRect, 'top' | 'left' | 'right' | 'bottom' | 'width' | 'height'>;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function findNextVisibleStep(tour: TourDefinition, fromIndex: number, direction: 1 | -1): number {
  for (let i = fromIndex; i >= 0 && i < tour.steps.length; i += direction) {
    const step = tour.steps[i];
    if (step.scene && step.scene !== 'default') return i;
    const target = document.querySelector<HTMLElement>(step.target);
    if (target && target.offsetParent !== null) return i;
  }
  return -1;
}

function prepareTourScene(scene: TourScene | undefined) {
  if (!scene || scene === 'default') return;
  const sessionStore = useSessionStore.getState();

  sessionStore.setSidebarTab('sessions');
  sessionStore.setSidebarOpen(true);
  sessionStore.setActiveView('aiTeam');
}

function useTargetRect(step: TourStep | null) {
  const [rect, setRect] = useState<RectLike | null>(null);

  useEffect(() => {
    if (!step) {
      setRect(null);
      return;
    }

    let frame = 0;
    let retryCount = 0;
    let scrolledToTarget = false;
    const update = () => {
      const target = document.querySelector<HTMLElement>(step.target);
      if (!target || target.offsetParent === null) {
        setRect(null);
        if (retryCount < 120) {
          retryCount += 1;
          frame = requestAnimationFrame(update);
        }
        return;
      }
      if (!scrolledToTarget) {
        target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
        scrolledToTarget = true;
      }
      const next = target.getBoundingClientRect();
      setRect({
        top: next.top,
        left: next.left,
        right: next.right,
        bottom: next.bottom,
        width: next.width,
        height: next.height,
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [step]);

  return rect;
}

function TourOverlay({
  activeTour,
  activeStep,
  stepIndex,
  endTour,
  nextStep,
  previousStep,
}: Pick<TourContextValue, 'activeTour' | 'activeStep' | 'stepIndex' | 'endTour' | 'nextStep' | 'previousStep'>) {
  const rect = useTargetRect(activeStep);
  if (!activeTour || !activeStep || !rect) return null;

  const padding = 8;
  const spotlight = {
    top: Math.max(8, rect.top - padding),
    left: Math.max(8, rect.left - padding),
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };

  const cardWidth = Math.min(340, window.innerWidth - 32);
  const gap = 14;
  const preferred = activeStep.placement ?? 'bottom';
  const topForHorizontal = clamp(rect.top + rect.height / 2 - 90, 16, window.innerHeight - 210);
  let cardTop = spotlight.top + spotlight.height + gap;
  let cardLeft = clamp(rect.left, 16, window.innerWidth - cardWidth - 16);

  if (preferred === 'top') {
    cardTop = clamp(spotlight.top - 190 - gap, 16, window.innerHeight - 210);
  } else if (preferred === 'left') {
    cardTop = topForHorizontal;
    cardLeft = clamp(spotlight.left - cardWidth - gap, 16, window.innerWidth - cardWidth - 16);
  } else if (preferred === 'right') {
    cardTop = topForHorizontal;
    cardLeft = clamp(spotlight.left + spotlight.width + gap, 16, window.innerWidth - cardWidth - 16);
  } else {
    cardTop = clamp(cardTop, 16, window.innerHeight - 210);
  }

  const isFirst = stepIndex === 0;
  const isLast = stepIndex >= activeTour.steps.length - 1;

  return (
    <div className="tower-tour-root" role="dialog" aria-modal="true" aria-label={activeTour.title}>
      <div className="tower-tour-dim" onClick={endTour} />
      <div
        className="tower-tour-spotlight"
        style={{ top: spotlight.top, left: spotlight.left, width: spotlight.width, height: spotlight.height }}
        aria-hidden="true"
      />
      <div className="tower-tour-card" style={{ top: cardTop, left: cardLeft, width: cardWidth }}>
        <div className="tower-tour-eyebrow">
          <span>{activeTour.title}</span>
          <span className="tower-tour-progress">{stepIndex + 1}/{activeTour.steps.length}</span>
        </div>
        <h2 className="tower-tour-title">{activeStep.title}</h2>
        <p className="tower-tour-description">{activeStep.description}</p>
        <div className="tower-tour-actions">
          <button
            type="button"
            onClick={endTour}
            className="tower-tour-button tower-tour-button--ghost"
          >
            닫기
          </button>
          <div className="tower-tour-nav-actions">
            <button
              type="button"
              onClick={previousStep}
              disabled={isFirst}
              className="tower-tour-button tower-tour-button--secondary"
            >
              이전
            </button>
            <button
              type="button"
              onClick={nextStep}
              className="tower-tour-button tower-tour-button--primary"
            >
              {isLast ? '완료' : '다음'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TourProvider({ children }: { children: React.ReactNode }) {
  const [activeTour, setActiveTour] = useState<TourDefinition | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [sceneReady, setSceneReady] = useState(true);

  const endTour = useCallback(() => {
    if (activeTour) markTowerGuideSeen();
    setActiveTour(null);
    setStepIndex(0);
  }, [activeTour]);

  const startTour = useCallback((tourId: string) => {
    const tour = getTourDefinition(tourId);
    if (!tour) return;
    const sessionStore = useSessionStore.getState();
    sessionStore.setActiveView('chat');
    sessionStore.setSidebarTab('sessions');
    sessionStore.setSidebarOpen(true);
    const firstVisible = findNextVisibleStep(tour, 0, 1);
    if (firstVisible < 0) return;
    markTowerGuideSeen();
    setActiveTour(tour);
    setStepIndex(firstVisible);
  }, []);

  useEffect(() => {
    const scene = activeTour?.steps[stepIndex]?.scene;
    if (!activeTour || !scene || scene === 'default') {
      setSceneReady(true);
      return;
    }
    setSceneReady(false);
    prepareTourScene(scene);
    const frame = window.requestAnimationFrame(() => setSceneReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, [activeTour, stepIndex]);

  const nextStep = useCallback(() => {
    if (!activeTour) return;
    const next = findNextVisibleStep(activeTour, stepIndex + 1, 1);
    if (next < 0) {
      markTourCompleted(activeTour.id);
      endTour();
      return;
    }
    setStepIndex(next);
  }, [activeTour, endTour, stepIndex]);

  const previousStep = useCallback(() => {
    if (!activeTour) return;
    const previous = findNextVisibleStep(activeTour, stepIndex - 1, -1);
    if (previous >= 0) setStepIndex(previous);
  }, [activeTour, stepIndex]);

  useEffect(() => {
    const handler = (event: Event) => {
      const tourId = (event as CustomEvent<{ tourId?: string }>).detail?.tourId ?? 'beginner';
      startTour(tourId);
    };
    window.addEventListener('tower-start-tour', handler as EventListener);
    return () => window.removeEventListener('tower-start-tour', handler as EventListener);
  }, [startTour]);

  useEffect(() => {
    if (!activeTour) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') endTour();
      if (event.key === 'ArrowRight') nextStep();
      if (event.key === 'ArrowLeft') previousStep();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTour, endTour, nextStep, previousStep]);

  const activeStep = sceneReady ? activeTour?.steps[stepIndex] ?? null : null;
  const value = useMemo<TourContextValue>(() => ({
    activeTour,
    activeStep,
    stepIndex,
    startTour,
    endTour,
    nextStep,
    previousStep,
  }), [activeTour, activeStep, stepIndex, startTour, endTour, nextStep, previousStep]);

  return (
    <TourContext.Provider value={value}>
      {children}
      <TourOverlay
        activeTour={activeTour}
        activeStep={activeStep}
        stepIndex={stepIndex}
        endTour={endTour}
        nextStep={nextStep}
        previousStep={previousStep}
      />
    </TourContext.Provider>
  );
}

export function useTour() {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTour must be used inside TourProvider');
  return ctx;
}
