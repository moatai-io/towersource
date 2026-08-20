import React from 'react';
import { useTranslation } from 'react-i18next';
import { usePinStore, type Pin } from '../../stores/pin-store';

interface PinListProps {
  onPinClick: (pin: Pin) => void;
  onUnpin: (id: number) => void;
  /** Embedded mode is used at the top of the Files tab, above project trees. */
  embedded?: boolean;
  /** In embedded mode, avoid a large empty state so project files stay first. */
  hideEmpty?: boolean;
}

const fileTypeAccent: Record<string, string> = {
  markdown: 'bg-gray-400/70',
  html: 'bg-orange-300/80',
  text: 'bg-gray-500/70',
  python: 'bg-green-400/80',
  typescript: 'bg-blue-400/80',
  javascript: 'bg-yellow-300/80',
  folder: 'bg-yellow-400/80',
};

const fileTypeBadge: Record<string, string> = {
  markdown: 'MD',
  html: 'HTML',
  text: 'TXT',
  python: 'PY',
  typescript: 'TS',
  javascript: 'JS',
  folder: 'DIR',
};

export function PinList({ onPinClick, onUnpin, embedded = false, hideEmpty = false }: PinListProps) {
  const { t } = useTranslation('files');
  const pins = usePinStore((s) => s.pins);
  const [embeddedCollapsed, setEmbeddedCollapsed] = React.useState(() => {
    if (!embedded || typeof window === 'undefined') return false;
    return localStorage.getItem('tower:files-pins-collapsed') === '1';
  });

  React.useEffect(() => {
    if (!embedded || typeof window === 'undefined') return;
    localStorage.setItem('tower:files-pins-collapsed', embeddedCollapsed ? '1' : '0');
  }, [embedded, embeddedCollapsed]);

  if (pins.length === 0) {
    if (hideEmpty) return null;
    return (
      <div className="px-4 py-8 text-center">
        <div className="text-surface-700 text-3xl mb-2">&#128204;</div>
        <p className="text-[15px] text-surface-700">
          {t('pins.empty')}
        </p>
        <p className="text-[13px] text-surface-800 mt-1">
          {t('pins.emptyHint')}
        </p>
      </div>
    );
  }

  return (
    <div className={embedded ? 'px-2 py-1.5 border-b border-surface-800/60 space-y-1' : 'px-3 space-y-0.5'}>
      {embedded && (
        <button
          type="button"
          onClick={() => setEmbeddedCollapsed((v) => !v)}
          className="w-full px-1 py-0.5 flex items-center gap-1.5 text-[12px] text-gray-600 uppercase tracking-wide font-medium hover:text-gray-400 transition-colors"
          title={embeddedCollapsed ? t('pins.expand') : t('pins.collapse')}
        >
          <svg className={`w-3 h-3 transition-transform ${embeddedCollapsed ? '' : 'rotate-90'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="flex-1 text-left">{t('pins.title')}</span>
          <span className="text-[11px] text-surface-700">{pins.length}</span>
        </button>
      )}
      {(!embedded || !embeddedCollapsed) && pins.map((pin) => (
        <div
          key={pin.id}
          className="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-800 transition-colors cursor-pointer"
          title={pin.file_path}
          onClick={() => onPinClick(pin)}
          draggable
          onDragStart={(e) => {
            const data = {
              type: 'file',
              label: pin.title,
              content: pin.file_path,
            };
            e.dataTransfer.setData('application/x-attachment', JSON.stringify(data));
            e.dataTransfer.effectAllowed = 'copy';
          }}
        >
          <span className={`w-0.5 h-4 rounded-full shrink-0 ${fileTypeAccent[pin.file_type] || 'bg-gray-500/70'}`} />
          <span className="text-sm text-gray-300 truncate flex-1">{pin.title}</span>
          <span className="text-[11px] font-bold text-surface-600 bg-surface-800 px-1.5 py-0.5 rounded">
            {fileTypeBadge[pin.file_type] || pin.file_type.toUpperCase()}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onUnpin(pin.id);
            }}
            className="opacity-0 group-hover:opacity-100 p-0.5 text-surface-600 hover:text-red-400 transition-all"
            title={t('pins.remove')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
