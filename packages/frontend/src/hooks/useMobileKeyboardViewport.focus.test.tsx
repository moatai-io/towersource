// @vitest-environment jsdom
import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useMobileKeyboardViewport } from './useMobileKeyboardViewport';
afterEach(() => { cleanup(); document.body.innerHTML = ''; });
it('hides navigation on text focus even without viewport shrink, restores on blur', () => {
 const textarea = document.createElement('textarea'); document.body.append(textarea);
 const { result } = renderHook(() => useMobileKeyboardViewport(true));
 act(() => textarea.focus());
 expect(result.current.hideNavigation).toBe(true);
 expect(result.current.height).toBe('100dvh');
 act(() => textarea.blur());
 expect(result.current.hideNavigation).toBe(false);
});
it('does not hide navigation for a button or on desktop', () => {
 const button = document.createElement('input'); button.type='button'; document.body.append(button);
 const { result, rerender } = renderHook(({ enabled }) => useMobileKeyboardViewport(enabled), { initialProps: { enabled:true } });
 act(() => button.focus()); expect(result.current.hideNavigation).toBe(false);
 const textarea = document.createElement('textarea'); document.body.append(textarea);
 rerender({enabled:false}); act(() => textarea.focus()); expect(result.current.hideNavigation).toBe(false);
});
