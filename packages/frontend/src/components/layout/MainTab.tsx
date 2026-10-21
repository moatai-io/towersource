import React from 'react';

type MainTabHeight = 'chat' | 'standard';

interface MainTabProps {
  active: boolean;
  isMobile: boolean;
  height?: MainTabHeight;
  title: string;
  children: React.ReactNode;
  className?: string;
  dataRunState?: string;
  onSelect?: () => void;
  onClose?: () => void;
  onPin?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}

export function MainTab({
  active,
  isMobile,
  height = 'standard',
  title,
  children,
  className = '',
  dataRunState,
  onSelect,
  onClose,
  onPin,
  onContextMenu,
}: MainTabProps) {
  const mobileHeight = height === 'chat' ? 'h-12' : 'h-10';
  return (
    <div
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      onAuxClick={(event) => {
        if (event.button === 1 && onClose) {
          event.preventDefault();
          onClose();
        }
      }}
      onDoubleClick={(event) => {
        if (!onPin) return;
        event.stopPropagation();
        onPin();
      }}
      onContextMenu={onContextMenu}
      data-run-state={dataRunState}
      data-active={active ? 'true' : 'false'}
      data-mobile={isMobile ? 'true' : 'false'}
      className={`tower-main-tab group relative flex w-full min-w-0 max-w-none flex-1 items-center gap-1 px-2 ${isMobile ? mobileHeight : 'h-7'} rounded-t-md rounded-b-none whitespace-nowrap cursor-pointer transition-[background-color,color,opacity,transform] ${className}`.trim()}
      title={title}
    >
      {children}
    </div>
  );
}

export function MainTabPinButton({ pinned, isMobile, label, onToggle }: {
  pinned: boolean;
  isMobile: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onToggle(); }}
      aria-label={label}
      aria-pressed={pinned}
      title={label}
      className={`tower-main-tab-pin ${isMobile ? 'h-8 w-8' : 'h-5 w-5'} flex shrink-0 items-center justify-center rounded transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary-400 ${pinned ? 'text-primary-400 hover:bg-primary-500/10 hover:text-primary-300' : 'text-surface-500 hover:bg-surface-700 hover:text-gray-100'}`}
    >
      <svg className={isMobile ? 'h-4 w-4' : 'h-3.5 w-3.5'} fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.5 4.5v4.25l2.75 2.75H13v7l-2 2v-9H6.75L9.5 8.75V4.5" />
      </svg>
    </button>
  );
}

export function MainTabCloseButton({ isMobile, label, onClose, overlay = false, alwaysVisible = false }: {
  isMobile: boolean;
  label: string;
  onClose: () => void;
  overlay?: boolean;
  alwaysVisible?: boolean;
}) {
  const button = (
    <button
      onClick={(event) => { event.stopPropagation(); onClose(); }}
      aria-label={label}
      className={`${isMobile ? 'h-8 w-8' : overlay ? 'h-5 w-5' : 'h-4 w-4'} flex shrink-0 items-center justify-center rounded text-gray-500 hover:bg-surface-700 hover:text-gray-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary-400`}
    >
      <svg className={isMobile ? 'h-4 w-4' : 'h-3 w-3'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  );

  if (isMobile || !overlay) {
    return <div className={`tower-main-tab-close ${isMobile || alwaysVisible ? 'shrink-0' : 'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100'}`}>{button}</div>;
  }
  return (
    <div className="tower-main-tab-close pointer-events-none absolute inset-y-0 right-0 flex items-center bg-[var(--th-bg-surface)] pl-1 pr-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
      {button}
    </div>
  );
}
