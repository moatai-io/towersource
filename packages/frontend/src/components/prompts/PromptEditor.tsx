import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface PromptEditorProps {
  open: boolean;
  onClose: () => void;
  onSave: (title: string, content: string) => void;
  initial?: { title: string; content: string };
}

export function PromptEditor({ open, onClose, onSave, initial }: PromptEditorProps) {
  const { t } = useTranslation('chat');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTitle(initial?.title || '');
      setContent(initial?.content || '');
      setTimeout(() => titleRef.current?.focus(), 50);
    }
  }, [open, initial]);

  if (!open) return null;

  const handleSave = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    onSave(trimmed, content);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md bg-surface-900 border border-surface-700 rounded-xl shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-gray-200 mb-4">
          {initial ? t('editPrompt') : t('newPrompt')}
        </h3>

        <input
          ref={titleRef}
          type="text"
          placeholder={t('promptTitlePlaceholder')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full bg-surface-800 border border-surface-700 rounded-lg text-[15px] text-gray-200 px-3 py-2 mb-3 outline-none focus:border-primary-500/50 transition-colors"
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
        />

        <textarea
          placeholder={t('promptContentPlaceholder')}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={6}
          className="w-full bg-surface-800 border border-surface-700 rounded-lg text-[15px] text-gray-200 px-3 py-2 mb-4 outline-none focus:border-primary-500/50 resize-none transition-colors"
        />

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-[14px] text-gray-400 hover:text-gray-200 rounded-md transition-colors"
          >
            {t('common:cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={!title.trim()}
            className="px-4 py-1.5 text-[14px] bg-primary-600 hover:bg-primary-500 disabled:bg-surface-700 disabled:text-surface-500 text-white rounded-md font-medium transition-colors"
          >
            {t('common:save')}
          </button>
        </div>
      </div>
    </div>
  );
}
