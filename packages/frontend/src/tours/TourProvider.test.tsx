// @vitest-environment jsdom
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TourProvider } from './TourProvider';

vi.mock('../stores/session-store', () => ({
  useSessionStore: {
    getState: () => ({
      setActiveView: vi.fn(),
      setSidebarTab: vi.fn(),
      setSidebarOpen: vi.fn(),
    }),
  },
}));

vi.mock('./tourState', () => ({
  markTourCompleted: vi.fn(),
  markTowerGuideSeen: vi.fn(),
}));

describe('TourProvider', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get() {
        return document.body;
      },
    });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.getBoundingClientRect = () => ({
      top: 24,
      left: 24,
      right: 64,
      bottom: 64,
      width: 40,
      height: 40,
      x: 24,
      y: 24,
      toJSON: () => ({}),
    });
  });

  it('opens the Tower guide after an initially inactive render without changing hook order', async () => {
    render(
      <TourProvider>
        <button type="button" data-tour-id="app-menu">Menu</button>
      </TourProvider>,
    );

    await act(async () => {
      window.dispatchEvent(new CustomEvent('tower-start-tour', { detail: { tourId: 'beginner' } }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
