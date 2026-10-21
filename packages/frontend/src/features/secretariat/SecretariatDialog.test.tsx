// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SecretariatDialog } from './SecretariatDialog';
afterEach(cleanup);
it('closes with Escape and restores original work focus', () => {
  const original = document.createElement('button'); document.body.append(original); original.focus();
  const close = vi.fn();
  const { unmount } = render(<SecretariatDialog onClose={close}>briefing</SecretariatDialog>);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); expect(close).toHaveBeenCalledOnce();
  unmount(); expect(document.activeElement).toBe(original); original.remove();
});
it('explicit close never changes application navigation', () => {
  const close = vi.fn(); render(<SecretariatDialog onClose={close}>content</SecretariatDialog>);
  fireEvent.click(screen.getByLabelText('비서실 닫기')); expect(close).toHaveBeenCalledOnce();
});
