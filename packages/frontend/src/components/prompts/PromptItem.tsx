import { useTranslation } from 'react-i18next';
import React from 'react';
import type { PromptItem as PromptItemType } from '../../stores/prompt-store';

interface PromptItemProps {
  prompt: PromptItemType;
  onClick: (prompt: PromptItemType) => void;
  onInsert?: (prompt: PromptItemType) => void;
  onEdit?: (prompt: PromptItemType) => void;
  onDelete?: (id: number | string) => void;
}

export function PromptItem({ prompt, onClick, onInsert, onEdit, onDelete }: PromptItemProps) {
  const { t } = useTranslation('common');
  const handleDragStart = (e: React.DragEvent) => {
    const isCommand = prompt.source === 'commands';
    const data = {
      type: isCommand ? 'command' : 'prompt',
      label: prompt.title,
      content: isCommand ? (prompt.title.startsWith('/') ? prompt.title : `/${prompt.title}`) : prompt.content,
    };
    e.dataTransfer.setData('application/x-attachment', JSON.stringify(data));
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div
      className="group flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-surface-800/50 cursor-pointer transition-colors"
      onClick={() => onClick(prompt)}
      draggable
      onDragStart={handleDragStart}
    >
      <svg className="tone-warning tone-text w-3.5 h-3.5 opacity-70 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
      <span className="text-[14px] text-gray-300 truncate flex-1">{prompt.title}</span>
      <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${
        prompt.source === 'commands'
          ? 'bg-blue-900/30 text-blue-400 border border-blue-500/20'
          : 'bg-surface-700/50 text-gray-400 border border-surface-600/30'
      }`}>
        {prompt.source === 'commands' ? 'cmd' : 'user'}
      </span>
      <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
        {onInsert && (
          <button
            onClick={(e) => { e.stopPropagation(); onInsert(prompt); }}
            className="p-0.5 text-gray-500 hover:text-primary-400 transition-colors"
            title={t('promptInsert', { defaultValue: '입력창에 넣기' })}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5m-7 7l7-7 7 7" />
            </svg>
          </button>
        )}
        {!prompt.readonly && onEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(prompt); }}
              className="p-0.5 text-gray-500 hover:text-gray-300 transition-colors"
              title={t('edit')}
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          )}
        {!prompt.readonly && onDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(prompt.id); }}
            className="p-0.5 text-gray-500 hover:text-red-400 transition-colors"
            title={t('delete')}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
