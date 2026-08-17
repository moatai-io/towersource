import { describe, expect, it } from 'vitest';
import { clampContextMenuPosition } from './ViewportContextMenu';

describe('clampContextMenuPosition', () => {
  it('keeps a pointer-adjacent menu unchanged when it fits', () => {
    expect(clampContextMenuPosition(120, 90, 180, 240, 1200, 800)).toEqual({ left: 120, top: 90 });
  });

  it('moves a menu left and up only when it would leave the viewport', () => {
    expect(clampContextMenuPosition(1150, 760, 180, 240, 1200, 800)).toEqual({ left: 1012, top: 552 });
  });

  it('preserves viewport padding for negative pointer coordinates', () => {
    expect(clampContextMenuPosition(-20, -10, 180, 240, 1200, 800)).toEqual({ left: 8, top: 8 });
  });
});
