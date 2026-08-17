import React, { useCallback, useRef } from 'react';
import { useFileStore, type FileTab } from '../../stores/file-store';
import { useConfirm, usePrompt } from '../../hooks/useDialog';
import { useTranslation } from 'react-i18next';

function decodeName(raw: string): string {
  try {
    if (/[\u00c0-\u00ff][\u0080-\u00bf]/.test(raw)) {
      const bytes = new Uint8Array([...raw].map(c => c.charCodeAt(0)));
      return new TextDecoder('utf-8').decode(bytes).normalize('NFC');
    }
    return raw.normalize('NFC');
  } catch {
    return raw.normalize('NFC');
  }
}

// File extension → dot color
const extColors: Record<string, string> = {
  md: 'bg-gray-400', ts: 'bg-blue-400', tsx: 'bg-blue-400',
  js: 'bg-yellow-300', jsx: 'bg-yellow-300', py: 'bg-green-400',
  json: 'bg-yellow-500', html: 'bg-orange-300', css: 'bg-blue-300',
  pdf: 'bg-red-400', png: 'bg-pink-400', jpg: 'bg-pink-400',
  yaml: 'bg-orange-400', yml: 'bg-orange-400', sql: 'bg-purple-300',
  dxf: 'bg-cyan-400', dwg: 'bg-cyan-500',
};

export function TabBar() {
  const { t } = useTranslation('files');
  const tabs = useFileStore((s) => s.tabs);
  const activeTabId = useFileStore((s) => s.activeTabId);
  const setActiveTab = useFileStore((s) => s.setActiveTab);
  const closeTab = useFileStore((s) => s.closeTab);
  const closeOtherTabs = useFileStore((s) => s.closeOtherTabs);
  const closeAllTabs = useFileStore((s) => s.closeAllTabs);
  const reorderTabs = useFileStore((s) => s.reorderTabs);
  const pinTab = useFileStore((s) => s.pinTab);
  const confirm = useConfirm();
  const prompt = usePrompt();
  const isTouchDevice = useRef(typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0));

  // Double click → pin tab
  const handleDoubleClick = useCallback((tab: FileTab) => {
    if (!tab.pinned) pinTab(tab.id);
  }, [pinTab]);

  // Drag state
  const dragIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = React.useState<number | null>(null);

  const confirmCloseModified = useCallback(async (): Promise<boolean> => {
    return await confirm({
      title: t('unsavedChanges'),
      message: t('confirmCloseUnsavedChanges'),
      confirmLabel: t('close'),
      danger: true,
    });
  }, [confirm, t]);

  const handleClose = useCallback(async (e: React.MouseEvent, tab: FileTab) => {
    e.stopPropagation();
    if (tab.modified && !(await confirmCloseModified())) return;
    closeTab(tab.id);
  }, [closeTab, confirmCloseModified]);

  const handleMiddleClick = useCallback(async (e: React.MouseEvent, tab: FileTab) => {
    if (e.button === 1) {
      e.preventDefault();
      if (tab.modified && !(await confirmCloseModified())) return;
      closeTab(tab.id);
    }
  }, [closeTab, confirmCloseModified]);

  const handleContextMenu = useCallback(async (e: React.MouseEvent, tab: FileTab) => {
    e.preventDefault();
    // Simple context menu — TODO: proper dropdown in the future
    const items = [t('closeOtherTabs'), t('closeAllTabs')];
    const choice = await prompt({
      title: t('manageTabs'),
      message: items.map((item, i) => `${i + 1}: ${item}`).join('\n'),
      placeholder: t('enterNumber'),
    });
    if (choice === '1') closeOtherTabs(tab.id);
    if (choice === '2') closeAllTabs();
  }, [closeOtherTabs, closeAllTabs, prompt, t]);

  // Drag & drop reorder
  const handleDragStart = useCallback((e: React.DragEvent, idx: number) => {
    dragIdx.current = idx;
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIdx(idx);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    if (dragIdx.current !== null && dragIdx.current !== targetIdx) {
      reorderTabs(dragIdx.current, targetIdx);
    }
    dragIdx.current = null;
    setDragOverIdx(null);
  }, [reorderTabs]);

  const handleDragEnd = useCallback(() => {
    dragIdx.current = null;
    setDragOverIdx(null);
  }, []);

  if (tabs.length === 0) return null;

  return (
    <div className={`flex shrink-0 items-center bg-surface-900 border-b border-surface-700 overflow-x-auto scrollbar-none leading-none ${isTouchDevice.current ? 'min-h-[42px]' : 'min-h-[34px]'}`}>
      {tabs.map((tab, idx) => {
        const isActive = tab.id === activeTabId;
        const fileName = decodeName(tab.path.split('/').pop() || '');
        const ext = fileName.split('.').pop()?.toLowerCase() || '';
        const dotColor = extColors[ext] || 'bg-gray-500';
        const isDragOver = dragOverIdx === idx;

        return (
          <div
            key={tab.id}
            className={`
              group flex items-center gap-1.5 px-3 text-sm cursor-pointer
              border-r border-surface-700 shrink-0 max-w-[180px] ${isTouchDevice.current ? 'py-2 min-h-[40px]' : 'py-1.5'}
              transition-colors select-none
              ${isActive
                ? 'bg-surface-800 text-gray-200'
                : 'text-gray-500 hover:text-gray-300 hover:bg-surface-800/50'
              }
              ${isDragOver ? 'border-l-2 border-l-primary-500' : ''}
            `}
            onClick={() => setActiveTab(tab.id)}
            onDoubleClick={() => handleDoubleClick(tab)}
            onMouseDown={(e) => handleMiddleClick(e, tab)}
            onContextMenu={(e) => handleContextMenu(e, tab)}
            draggable={!isTouchDevice.current}
            onDragStart={(e) => handleDragStart(e, idx)}
            onDragOver={(e) => handleDragOver(e, idx)}
            onDrop={(e) => handleDrop(e, idx)}
            onDragEnd={handleDragEnd}
            title={tab.path}
          >
            {/* File type dot */}
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />

            {/* File name — italic = temporary tab, normal = pinned */}
            <span className={`truncate ${tab.pinned ? '' : 'italic opacity-80'}`}>
              {fileName}
            </span>

            {/* Modified indicator or close button */}
            {tab.modified ? (
              <span
                className={`${isTouchDevice.current ? 'w-8 h-8 text-[14px]' : 'w-4 h-4 text-[12px]'} shrink-0 flex items-center justify-center text-primary-400 hover:text-red-400 cursor-pointer`}
                onClick={(e) => handleClose(e, tab)}
                title={t('unsavedChangesClickToClose')}
              >
                ●
              </span>
            ) : (
              <button
                className={`${isTouchDevice.current ? 'w-8 h-8 opacity-100 text-[14px]' : 'w-4 h-4 opacity-0 group-hover:opacity-100 text-[12px]'} shrink-0 flex items-center justify-center
                  transition-opacity
                  text-gray-500 hover:text-red-400`}
                onClick={(e) => handleClose(e, tab)}
                title={t('closeTab')}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
