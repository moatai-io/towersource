import { describe, expect, it } from 'vitest';
import { deriveMobileKeyboardViewport } from './useMobileKeyboardViewport';

describe('deriveMobileKeyboardViewport', () => {
  it('keeps the dynamic viewport when no editable control is focused', () => {
    expect(deriveMobileKeyboardViewport({
      layoutHeight: 844,
      visualHeight: 780,
      offsetTop: 0,
      editableFocused: false,
    })).toEqual({ height: '100dvh', keyboardOpen: false });
  });

  it('uses the visible bottom while the software keyboard is open', () => {
    expect(deriveMobileKeyboardViewport({
      layoutHeight: 844,
      visualHeight: 510,
      offsetTop: 0,
      editableFocused: true,
    })).toEqual({ height: '510px', keyboardOpen: true });
  });

  it('includes iOS Chrome visual viewport panning without double-moving the shell', () => {
    expect(deriveMobileKeyboardViewport({
      layoutHeight: 844,
      visualHeight: 470,
      offsetTop: 40,
      editableFocused: true,
    })).toEqual({ height: '510px', keyboardOpen: true });
  });

  it('does not treat browser chrome movement or a hardware keyboard as a software keyboard', () => {
    expect(deriveMobileKeyboardViewport({
      layoutHeight: 844,
      visualHeight: 790,
      offsetTop: 0,
      editableFocused: true,
    })).toEqual({ height: '100dvh', keyboardOpen: false });
  });
});
