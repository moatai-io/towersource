// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useResizablePane } from './useResizablePane';

interface ProbeProps {
  onResize?: (value: number) => void;
  onResizeEnd?: (value: number) => void;
  onPreview?: (value: number, startValue: number) => void;
}

function Probe({ onResize, onResizeEnd, onPreview }: ProbeProps) {
  const { isResizing, startResize } = useResizablePane({
    value: 200,
    calculateValue: ({ clientX, startX, startValue }) => startValue + clientX - startX,
    onResize,
    onResizeEnd,
    onPreview,
  });
  return <button data-testid="handle" data-resizing={String(isResizing)} onPointerDown={startResize}>resize</button>;
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

describe('useResizablePane', () => {
  it('updates during pointer movement and commits the final value on pointerup', () => {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();
    const onPreview = vi.fn();
    render(<Probe onResize={onResize} onResizeEnd={onResizeEnd} onPreview={onPreview} />);

    fireEvent.pointerDown(screen.getByTestId('handle'), { clientX: 100 });
    expect(screen.getByTestId('handle')).toHaveAttribute('data-resizing', 'true');
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');

    fireEvent.pointerMove(window, { clientX: 135 });
    expect(onResize).toHaveBeenCalledWith(235);
    expect(onPreview).toHaveBeenCalledWith(235, 200);

    fireEvent.pointerUp(window, { clientX: 150 });
    expect(onResizeEnd).toHaveBeenCalledWith(250);
    expect(screen.getByTestId('handle')).toHaveAttribute('data-resizing', 'false');
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('finishes safely on pointercancel', () => {
    const onResizeEnd = vi.fn();
    render(<Probe onResizeEnd={onResizeEnd} />);

    fireEvent.pointerDown(screen.getByTestId('handle'), { clientX: 100 });
    fireEvent.pointerCancel(window, { clientX: 80 });

    expect(onResizeEnd).toHaveBeenCalledWith(180);
    expect(screen.getByTestId('handle')).toHaveAttribute('data-resizing', 'false');
  });

  it('removes global listeners and body locks when unmounted mid-drag', () => {
    const onResize = vi.fn();
    const view = render(<Probe onResize={onResize} />);

    fireEvent.pointerDown(screen.getByTestId('handle'), { clientX: 100 });
    view.unmount();
    fireEvent.pointerMove(window, { clientX: 140 });

    expect(onResize).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('does not leak the previous drag when a new drag starts', () => {
    const onResize = vi.fn();
    render(<Probe onResize={onResize} />);
    const handle = screen.getByTestId('handle');

    fireEvent.pointerDown(handle, { clientX: 100 });
    fireEvent.pointerDown(handle, { clientX: 120 });
    fireEvent.pointerMove(window, { clientX: 130 });

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenLastCalledWith(210);
  });
});
