// Owns: friendly Markdown writing surface for project .md files.
// Public API: MarkdownEditor.

import React, { useCallback, useMemo, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView, keymap, type KeyBinding } from '@codemirror/view';
import type { ChangeSpec, Extension } from '@codemirror/state';
import { useSettingsStore } from '../../../stores/settings-store';
import { toastError, toastSuccess } from '../../../utils/toast';

interface MarkdownEditorProps {
  value: string;
  filePath: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function fileDir(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx === -1 ? '' : filePath.slice(0, idx);
}

function baseNameWithoutExt(filePath: string): string {
  const name = filePath.split('/').pop() || 'note';
  return name.replace(/\.[^.]+$/, '') || 'note';
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeAssetName(file: File, index: number): string {
  const original = file.name && file.name !== 'image.png' ? file.name : `image-${timestamp()}-${index + 1}.png`;
  const clean = original.replace(/[^\p{L}\p{N}._-]/gu, '_');
  return clean || `image-${timestamp()}-${index + 1}.png`;
}

function relativePath(fromDir: string, absolutePath: string): string {
  if (!fromDir) return absolutePath;
  const from = fromDir.replace(/\/+/g, '/').replace(/\/$/, '').split('/').filter(Boolean);
  const to = absolutePath.replace(/\/+/g, '/').split('/').filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i += 1;
  const ups = Array.from({ length: from.length - i }, () => '..');
  const rest = to.slice(i);
  return [...ups, ...rest].join('/') || absolutePath.split('/').pop() || absolutePath;
}

async function uploadMarkdownAssets(filePath: string, files: File[]): Promise<string[]> {
  const dir = fileDir(filePath);
  const noteName = baseNameWithoutExt(filePath).replace(/[^\p{L}\p{N}._-]/gu, '_') || 'note';
  const targetDir = `${dir}/attachments/${noteName}`;
  const formData = new FormData();
  formData.append('targetDir', targetDir);
  formData.append('relativePaths', JSON.stringify(files.map((file, index) => safeAssetName(file, index))));
  for (const file of files) formData.append('files', file);

  const res = await fetch('/api/files/upload', { method: 'POST', headers: authHeaders(), body: formData });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  const results = Array.isArray(data.results) ? data.results : [];
  const failed = results.find((r: any) => r?.error);
  if (failed) throw new Error(`${failed.name || 'file'}: ${failed.error}`);
  return results.map((r: any) => String(r.path)).filter(Boolean);
}

function markdownForAssets(currentFilePath: string, files: File[], uploadedPaths: string[]): string {
  const dir = fileDir(currentFilePath);
  return uploadedPaths.map((path, index) => {
    const rel = relativePath(dir, path);
    const label = (files[index]?.name || path.split('/').pop() || 'image').replace(/\.[^.]+$/, '') || 'image';
    const isImage = files[index]?.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path);
    return isImage ? `![${label}](${rel})` : `[${label}](${rel})`;
  }).join('\n');
}

function toggleInlineMarker(view: EditorView, before: string, after = before, placeholder = ''): boolean {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.doc.sliceString(range.from, range.to);

  if (selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length) {
    const inner = selected.slice(before.length, selected.length - after.length);
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: inner },
      selection: { anchor: range.from, head: range.from + inner.length },
      scrollIntoView: true,
    });
    view.focus();
    return true;
  }

  const beforeText = state.doc.sliceString(Math.max(0, range.from - before.length), range.from);
  const afterText = state.doc.sliceString(range.to, Math.min(state.doc.length, range.to + after.length));
  if (selected && beforeText === before && afterText === after) {
    view.dispatch({
      changes: [
        { from: range.to, to: range.to + after.length, insert: '' },
        { from: range.from - before.length, to: range.from, insert: '' },
      ],
      selection: { anchor: range.from - before.length, head: range.to - before.length },
      scrollIntoView: true,
    });
    view.focus();
    return true;
  }

  const inner = selected || placeholder;
  const insert = `${before}${inner}${after}`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + before.length, head: range.from + before.length + inner.length },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

function insertMarkdownLink(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.doc.sliceString(range.from, range.to);
  const line = state.doc.lineAt(range.from);
  const lineText = line.text;
  const fromInLine = range.from - line.from;
  const toInLine = range.to - line.from;
  const linkRegex = /\[([^\]]*)\]\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(lineText))) {
    const start = match.index;
    const end = start + match[0].length;
    if (fromInLine >= start && toInLine <= end) {
      const label = match[1];
      const url = match[2];
      if (range.from <= line.from + start && range.to >= line.from + end) {
        view.dispatch({
          changes: { from: line.from + start, to: line.from + end, insert: label },
          selection: { anchor: line.from + start, head: line.from + start + label.length },
          scrollIntoView: true,
        });
      } else {
        const urlStart = line.from + start + match[0].indexOf(`(${url})`) + 1;
        view.dispatch({ selection: { anchor: urlStart, head: urlStart + url.length }, scrollIntoView: true });
      }
      view.focus();
      return true;
    }
  }

  const label = selected || 'link text';
  const insert = `[${label}](url)`;
  const urlStart = range.from + label.length + 3;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: urlStart, head: urlStart + 3 },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

const writingTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent' },
  '.cm-scroller': { fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  '.cm-content': {
    maxWidth: '920px',
    margin: '0 auto',
    padding: '32px 40px 56px',
    fontSize: '15.5px',
    lineHeight: '1.72',
    caretColor: '#a5b4fc',
  },
  '.cm-line': { padding: '0 2px' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.035)' },
  '.cm-gutters': { display: 'none' },
  '.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(99,102,241,0.32)' },
});

const writingThemeLight = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent' },
  '.cm-content': { color: '#1f2937' },
  '.cm-line': { color: '#1f2937' },
  '.cm-activeLine': { backgroundColor: 'rgba(0,0,0,0.035)' },
});

function forSelectedLines(view: EditorView, transform: (lineText: string) => string): boolean {
  const { state } = view;
  const selection = state.selection.main;
  const startLine = state.doc.lineAt(selection.from);
  const endLine = state.doc.lineAt(Math.max(selection.from, selection.to - (selection.to > selection.from ? 1 : 0)));
  const changes: ChangeSpec[] = [];
  for (let lineNo = startLine.number; lineNo <= endLine.number; lineNo += 1) {
    const line = state.doc.line(lineNo);
    changes.push({ from: line.from, to: line.to, insert: transform(line.text) });
  }
  view.dispatch({ changes, scrollIntoView: true });
  view.focus();
  return true;
}

function toggleLinePrefix(view: EditorView, prefix: string): boolean {
  return forSelectedLines(view, (line) => line.startsWith(prefix) ? line.slice(prefix.length) : `${prefix}${line}`);
}

function toggleTodo(view: EditorView): boolean {
  return forSelectedLines(view, (line) => {
    if (/^- \[[ xX]\] /.test(line)) return line.replace(/^- \[[ xX]\] /, '');
    if (line.startsWith('- ')) return line.replace(/^- /, '- [ ] ');
    return `- [ ] ${line}`;
  });
}

function setHeading(view: EditorView, level: number): boolean {
  return forSelectedLines(view, (line) => {
    const match = line.match(/^(#{1,6})\s+(.*)$/);
    if (match?.[1].length === level) return match[2];
    const bare = line.replace(/^#{1,6}\s+/, '');
    return `${'#'.repeat(level)} ${bare || '제목'}`;
  });
}

function insertBlock(view: EditorView, text: string): boolean {
  const pos = view.state.selection.main.from;
  const needsLeadingBreak = pos > 0 && !view.state.doc.sliceString(Math.max(0, pos - 1), pos).match(/\n/);
  const insert = `${needsLeadingBreak ? '\n' : ''}${text}\n`;
  view.dispatch({ changes: { from: pos, to: view.state.selection.main.to, insert }, selection: { anchor: pos + insert.length }, scrollIntoView: true });
  view.focus();
  return true;
}

export function MarkdownEditor({ value, filePath, onChange, onSave, readOnly = false }: MarkdownEditorProps) {
  const theme = useSettingsStore((s) => s.theme);
  const viewRef = useRef<EditorView | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadingRef = useRef(false);

  const insertFiles = useCallback(async (files: File[], insertAt?: number) => {
    const view = viewRef.current;
    if (!view || files.length === 0 || uploadingRef.current) return;
    uploadingRef.current = true;
    try {
      const uploadedPaths = await uploadMarkdownAssets(filePath, files);
      const markdownText = markdownForAssets(filePath, files, uploadedPaths);
      const pos = typeof insertAt === 'number' ? insertAt : view.state.selection.main.from;
      const needsLeadingBreak = pos > 0 && !view.state.doc.sliceString(Math.max(0, pos - 1), pos).match(/\n/);
      const insert = `${needsLeadingBreak ? '\n' : ''}${markdownText}\n`;
      view.dispatch({ changes: { from: pos, to: pos, insert }, selection: { anchor: pos + insert.length }, scrollIntoView: true });
      view.focus();
      toastSuccess(files.length > 1 ? `${files.length}개 파일을 문서에 삽입했습니다.` : '파일을 문서에 삽입했습니다.');
    } catch (err) {
      toastError(err instanceof Error ? err.message : '파일 삽입에 실패했습니다.');
    } finally {
      uploadingRef.current = false;
    }
  }, [filePath]);

  const runCommand = useCallback((command: (view: EditorView) => boolean) => {
    const view = viewRef.current;
    if (!view) return;
    command(view);
  }, []);

  const extensions = useMemo<Extension[]>(() => {
    const keyBindings: KeyBinding[] = [
      { key: 'Mod-s', run: () => { onSave?.(); return true; } },
      { key: 'Mod-b', run: (view) => toggleInlineMarker(view, '**', '**', 'bold text') },
      { key: 'Mod-i', run: (view) => toggleInlineMarker(view, '*', '*', 'italic text') },
      { key: 'Mod-k', run: insertMarkdownLink },
      { key: 'Mod-Alt-1', run: (view) => setHeading(view, 1) },
      { key: 'Mod-Alt-2', run: (view) => setHeading(view, 2) },
      { key: 'Mod-Alt-3', run: (view) => setHeading(view, 3) },
    ];

    return [
      writingTheme,
      theme === 'light' ? writingThemeLight : [],
      markdown(),
      keymap.of(keyBindings),
      EditorView.lineWrapping,
      EditorView.domEventHandlers({
        paste: (event, view) => {
          const files = Array.from(event.clipboardData?.items || [])
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile())
            .filter((file): file is File => !!file);
          if (files.length === 0) return false;
          event.preventDefault();
          void insertFiles(files, view.state.selection.main.from);
          return true;
        },
        dragover: (event) => {
          if (event.dataTransfer?.types.includes('Files')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            return true;
          }
          return false;
        },
        drop: (event, view) => {
          const files = Array.from(event.dataTransfer?.files || []);
          if (files.length === 0) return false;
          event.preventDefault();
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from;
          void insertFiles(files, pos);
          return true;
        },
      }),
    ];
  }, [insertFiles, onSave, theme]);

  return (
    <div className="flex h-full flex-col bg-surface-950">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-surface-800 bg-surface-950/95 px-3 py-1.5 text-[12px] text-surface-400">
        <button className="rounded px-2 py-1 hover:bg-surface-800 hover:text-surface-100" onClick={() => runCommand((v) => setHeading(v, 1))} title="제목 1 토글">H1</button>
        <button className="rounded px-2 py-1 hover:bg-surface-800 hover:text-surface-100" onClick={() => runCommand((v) => setHeading(v, 2))} title="제목 2 토글">H2</button>
        <button className="rounded px-2 py-1 hover:bg-surface-800 hover:text-surface-100" onClick={() => runCommand((v) => setHeading(v, 3))} title="제목 3 토글">H3</button>
        <span className="mx-1 h-4 w-px bg-surface-800" />
        <button className="rounded px-2 py-1 font-bold hover:bg-surface-800 hover:text-surface-100" onClick={() => runCommand((v) => toggleInlineMarker(v, '**', '**', '굵게'))} title="굵게 토글 (Ctrl/Cmd+B)">B</button>
        <button className="rounded px-2 py-1 italic hover:bg-surface-800 hover:text-surface-100" onClick={() => runCommand((v) => toggleInlineMarker(v, '*', '*', '기울임'))} title="기울임 토글 (Ctrl/Cmd+I)">I</button>
        <button className="rounded px-2 py-1 hover:bg-surface-800 hover:text-surface-100" onClick={() => runCommand(insertMarkdownLink)} title="링크 삽입/수정/제거 (Ctrl/Cmd+K)">Link</button>
        <span className="mx-1 h-4 w-px bg-surface-800" />
        <button className="rounded px-2 py-1 hover:bg-surface-800 hover:text-surface-100" onClick={() => runCommand((v) => toggleLinePrefix(v, '- '))} title="리스트 토글">List</button>
        <button className="rounded px-2 py-1 hover:bg-surface-800 hover:text-surface-100" onClick={() => runCommand(toggleTodo)} title="체크박스 토글">Todo</button>
        <button className="rounded px-2 py-1 hover:bg-surface-800 hover:text-surface-100" onClick={() => runCommand((v) => toggleLinePrefix(v, '> '))} title="인용 토글">Quote</button>
        <button className="rounded px-2 py-1 hover:bg-surface-800 hover:text-surface-100" onClick={() => runCommand((v) => insertBlock(v, '```\ncode\n```'))} title="코드블록">Code</button>
        <span className="mx-1 h-4 w-px bg-surface-800" />
        <button className="rounded px-2 py-1 hover:bg-surface-800 hover:text-surface-100" onClick={() => fileInputRef.current?.click()} title="이미지/파일 삽입">Attach</button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            if (files.length > 0) void insertFiles(files);
            e.currentTarget.value = '';
          }}
        />
        <span className="ml-auto hidden text-[11px] text-surface-600 sm:inline">Markdown · Ctrl/Cmd+S 저장 · 이미지 붙여넣기/드롭 가능</span>
      </div>
      <div className="min-h-0 flex-1">
        <CodeMirror
          value={value}
          theme={theme !== 'light' ? oneDark : 'light'}
          extensions={extensions}
          onChange={onChange}
          readOnly={readOnly}
          onCreateEditor={(view) => { viewRef.current = view; }}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            bracketMatching: true,
            autocompletion: false,
            highlightActiveLine: true,
            highlightActiveLineGutter: false,
          }}
          style={{ height: '100%' }}
        />
      </div>
    </div>
  );
}
