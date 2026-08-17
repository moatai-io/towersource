/* @vitest-environment jsdom */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { shouldUseFileBodySelectAll, selectElementTextContents } from './fileSelection';

describe('fileSelection', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.getSelection()?.removeAllRanges();
  });

  it('allows Mod+A to select the rendered file body when page body has focus', () => {
    const root = document.createElement('article');
    root.textContent = 'Rendered markdown body';
    document.body.appendChild(root);

    const event = new KeyboardEvent('keydown', { key: 'a', metaKey: true });
    expect(shouldUseFileBodySelectAll(event, root)).toBe(true);
  });

  it('does not steal Mod+A from text inputs or CodeMirror editors', () => {
    const root = document.createElement('article');
    const input = document.createElement('textarea');
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    document.body.append(root, input, editor);

    const inputEvent = new KeyboardEvent('keydown', { key: 'a', metaKey: true });
    Object.defineProperty(inputEvent, 'target', { value: input });

    const editorEvent = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true });
    Object.defineProperty(editorEvent, 'target', { value: editor });

    expect(shouldUseFileBodySelectAll(inputEvent, root)).toBe(false);
    expect(shouldUseFileBodySelectAll(editorEvent, root)).toBe(false);
  });

  it('selects exactly the target element text contents', () => {
    const header = document.createElement('header');
    header.textContent = 'Tower header';
    const root = document.createElement('article');
    root.textContent = 'Only file body';
    document.body.append(header, root);

    expect(selectElementTextContents(root)).toBe(true);
    expect(window.getSelection()?.toString()).toBe('Only file body');
  });

  it('returns false when browser selection is unavailable', () => {
    const root = document.createElement('article');
    const spy = vi.spyOn(window, 'getSelection').mockReturnValue(null);

    expect(selectElementTextContents(root)).toBe(false);
    spy.mockRestore();
  });
});
