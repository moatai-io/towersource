// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileOperationFeedback } from './FileOperationFeedback';
import { saveFileOperation } from './save-operation';
import { acknowledgeFileSave } from './save-acknowledgement';
import { reportUploadFailure, saveScope, useFileOperationFeedback } from './feedback';
import { useFileStore } from '../../stores/file-store';
vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
beforeEach(() => { useFileOperationFeedback.setState({ notices: {} }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('retains failure at its surface until dismissed and isolates other surfaces', () => {
  reportUploadFailure('upload:a', 2, 1, [{ error: 'secret-detail' }]);
  const view = render(<FileOperationFeedback scope="upload:b" />);
  expect(screen.queryByRole('status')).toBeNull();
  view.rerender(<FileOperationFeedback scope="upload:a" />);
  expect(screen.getByRole('status').textContent).not.toContain('secret-detail');
  fireEvent.click(screen.getByRole('button'));
  expect(screen.queryByRole('status')).toBeNull();
});
it.each([403, 409, 500])('does not acknowledge rejected HTTP saves (%s)', async status => {
  const saved = vi.fn();
  expect(await saveFileOperation('/a', async () => new Response('', { status }), saved)).toBe(false);
  expect(saved).not.toHaveBeenCalled();
  expect(useFileOperationFeedback.getState().notices[saveScope('/a')].status).toBe('failed');
});
it('does not replay ambiguous network failures and permits explicit subsequent save', async () => {
  const write = vi.fn().mockRejectedValue(new Error('private host details'));
  const saved = vi.fn();
  await saveFileOperation('/a', write, saved);
  expect(write).toHaveBeenCalledOnce(); expect(saved).not.toHaveBeenCalled();
  expect(useFileOperationFeedback.getState().notices[saveScope('/a')].message).not.toContain('private host');
  await saveFileOperation('/a', async () => new Response(''), saved);
  expect(saved).toHaveBeenCalledOnce();
});
it('prevents concurrent duplicate saves and expires success only', async () => {
  vi.useFakeTimers();
  let resolve!: (response: Response) => void;
  const pending = saveFileOperation('/a', () => new Promise(r => { resolve = r; }), vi.fn());
  const duplicate = vi.fn();
  expect(await saveFileOperation('/a', duplicate, vi.fn())).toBe(false);
  expect(duplicate).not.toHaveBeenCalled();
  render(<FileOperationFeedback scope={saveScope('/a')} />);
  expect(screen.queryByRole('button')).toBeNull();
  await act(async () => { resolve(new Response('')); await pending; });
  act(() => vi.advanceTimersByTime(3000));
  expect(screen.queryByRole('status')).toBeNull();
});
it('does not mark newer edits or another active file as saved', () => {
  const markSaved = vi.fn(), markTabSavedByPath = vi.fn();
  const original = useFileStore.getState();
  useFileStore.setState({ tabs: [{ id: 'a', path: '/a', content: 'newer', language: 'text', modified: true } as any], openFile: { path: '/b', content: 'other', language: 'text', modified: true }, markSaved, markTabSavedByPath });
  acknowledgeFileSave('/a', 'submitted');
  expect(markSaved).not.toHaveBeenCalled(); expect(markTabSavedByPath).not.toHaveBeenCalled();
  useFileStore.setState(original);
});
it('acknowledges matching submitted content without changing selection', () => {
  const markSaved = vi.fn(), markTabSavedByPath = vi.fn();
  const original = useFileStore.getState();
  useFileStore.setState({ tabs: [{ id: 'a', path: '/a', content: 'submitted', language: 'text', modified: true } as any], openFile: { path: '/b', content: 'other', language: 'text', modified: true }, markSaved, markTabSavedByPath });
  acknowledgeFileSave('/a', 'submitted');
  expect(markTabSavedByPath).toHaveBeenCalledWith('/a');
  expect(markSaved).not.toHaveBeenCalled();
  expect(useFileStore.getState().openFile?.path).toBe('/b');
  useFileStore.setState(original);
});
it('an old success timer cannot dismiss a later failure', async () => {
  vi.useFakeTimers();
  await saveFileOperation('/a', async () => new Response(''), vi.fn());
  render(<FileOperationFeedback scope={saveScope('/a')} />);
  await act(async () => { await saveFileOperation('/a', async () => new Response('', { status: 500 }), vi.fn()); });
  act(() => vi.advanceTimersByTime(4000));
  expect(screen.getByRole('status')).toBeTruthy();
  expect(useFileOperationFeedback.getState().notices[saveScope('/a')].status).toBe('failed');
});
it('unknown outcomes do not invent failed counts and remain isolated', async () => {
  const { reportUploadUnknown, uploadScope } = await import('./feedback');
  const a = uploadScope('tree', 'a'), b = uploadScope('tree', 'b');
  reportUploadUnknown(a);
  expect(useFileOperationFeedback.getState().notices[b]).toBeUndefined();
  expect(useFileOperationFeedback.getState().notices[a].message).not.toMatch(/\d/);
});
