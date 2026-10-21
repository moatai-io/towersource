import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { getModelIdForBackend, type ModelOption, useSessionAwareModel } from '../../stores/model-store';
import { useSessionStore } from '../../stores/session-store';
import { confirmEngineSwitch } from '../../stores/engine-pick';
import { EngineSwitchConfirmModal } from './EngineSwitchConfirmModal';
import { getDefaultModelRank, getModelCompany, getModelDisplayName } from './model-display';
import { ModelTokenPrice } from './ModelTokenPrice';
import { SessionReasoningSelector } from '../chat/SessionReasoningSelector';

interface ModelSelectorProps {
  dropdownAlign?: 'down' | 'up';
  className?: string;
  variant?: 'header' | 'composer';
}

export function ModelSelector({ dropdownAlign = 'down', className = '', variant = 'header' }: ModelSelectorProps = {}) {
  const { t } = useTranslation('layout');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ top?: number; bottom?: number; right: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || variant !== 'composer') return;
    const position = () => {
      const anchor = ref.current?.getBoundingClientRect();
      if (!anchor) return;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const available = dropdownAlign === 'up' ? anchor.top - 8 : viewportHeight - anchor.bottom - 8;
      setMenuPosition({
        ...(dropdownAlign === 'up' ? { bottom: viewportHeight - anchor.top + 4 } : { top: anchor.bottom + 4 }),
        right: Math.max(12, viewportWidth - anchor.right),
        maxHeight: Math.max(0, Math.min(available, viewportHeight * 0.7)),
      });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
    };
  }, [open, variant, dropdownAlign]);

  const {
    effectiveSelected,
    visibleClaudeModels,
    visiblePiModels,
    visibleLocalModels,
    pick,
    applyPickedModel,
  } = useSessionAwareModel();
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const [pendingSwitch, setPendingSwitch] = useState<
    { modelId: string; fromEngine: string; toEngine: string } | null
  >(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const allVisible = [...visibleClaudeModels, ...visiblePiModels, ...visibleLocalModels];
  const current =
    allVisible.find((m) => m.id === effectiveSelected) ||
    allVisible[0] ||
    {
      id: effectiveSelected,
      name: effectiveSelected.replace(/^pi:.*\//, '').replace(/-/g, ' '),
      badge: '',
    };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  if (!current) return null;

  const defaultPiModels = visiblePiModels
    .filter((model) => getDefaultModelRank(model) !== null)
    .sort((a, b) => getDefaultModelRank(a)! - getDefaultModelRank(b)!);
  const registryPiModels = visiblePiModels.filter((model) => getDefaultModelRank(model) === null);
  const hasPi = visiblePiModels.length > 0;
  const hasClaude = visibleClaudeModels.length > 0;
  const hasLocal = visibleLocalModels.length > 0;

  const handlePick = (modelId: string) => {
    const decision = pick(modelId);
    if (decision.kind === 'needs_confirm') {
      setOpen(false);
      setSwitchError(null);
      setPendingSwitch({ modelId, fromEngine: decision.fromEngine, toEngine: decision.toEngine });
    }
  };

  const handleConfirmSwitch = async () => {
    if (!pendingSwitch || !activeSessionId) return;
    setSwitchBusy(true);
    setSwitchError(null);
    const result = await confirmEngineSwitch(
      activeSessionId,
      pendingSwitch.toEngine,
      'user_request',
      getModelIdForBackend(pendingSwitch.modelId),
    );
    setSwitchBusy(false);
    if (result.ok) {
      applyPickedModel(pendingSwitch.modelId);
      setPendingSwitch(null);
    } else {
      setSwitchError(result.error?.message ?? t('engineSwitchFailed'));
    }
  };

  const handleCancelSwitch = () => {
    setPendingSwitch(null);
    setSwitchError(null);
  };

  const renderModel = (model: ModelOption) => {
    const company = getModelCompany(model);
    return (
      <button
        key={model.id}
        onClick={() => handlePick(model.id)}
        className={`flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors ${
          model.id === effectiveSelected
            ? 'bg-primary-600/12 text-primary-300'
            : 'text-gray-400 hover:bg-surface-800 hover:text-gray-200'
        }`}
      >
        <div className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${model.id === effectiveSelected ? 'bg-primary-400' : 'bg-surface-700'}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-[13px] font-medium">{getModelDisplayName(model, t)}</span>
            {company && <span className="shrink-0 text-[10px] text-surface-600">{company}</span>}
          </span>
          <ModelTokenPrice model={model} />
        </span>
        {model.id === effectiveSelected && (
          <svg className="mt-0.5 h-4 w-4 shrink-0 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </button>
    );
  };

  const menuContent = (
    <>
          <div className="border-b border-surface-700/60 px-3 pb-2 pt-1">
            <div className="text-[13px] font-semibold text-surface-200">{t('modelPickerTitle')}</div>
            <div className="mt-0.5 text-[11px] leading-4 text-surface-500">{t('modelPickerDescription')}</div>
          </div>
          {/* Claude models group */}
          {hasClaude && hasPi && (
            <div className="px-3 pt-2 pb-1 text-[12px] font-semibold text-surface-500 uppercase tracking-wider">
              Claude
            </div>
          )}
          {visibleClaudeModels.map(renderModel)}

          {/* Core/Lite remain easy to scan; the rest preserves backend registry order. */}
          {hasPi && (
            <>
              {hasClaude && <div className="border-t border-surface-700/50 mx-2 my-1" />}
              {defaultPiModels.length > 0 && (
                <div className="mx-2 my-1 rounded-lg border border-primary-500/20 bg-primary-500/[0.04] py-0.5">
                  <div className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-primary-400/80">
                    {t('defaultModels')}
                  </div>
                  {defaultPiModels.map(renderModel)}
                </div>
              )}
              {registryPiModels.length > 0 && defaultPiModels.length > 0 && <div className="border-t border-surface-700/50 mx-2 my-1" />}
              {registryPiModels.map(renderModel)}
            </>
          )}

          {/* Local LLM group */}
          {hasLocal && (
            <>
              {(hasClaude || hasPi) && <div className="border-t border-surface-700/50 mx-2 my-1" />}
              <div className="tone-success tone-text px-3 pt-1 pb-1 text-[12px] font-semibold opacity-70 uppercase tracking-wider">
                {t('localLlm')}
              </div>
              {visibleLocalModels.map(renderModel)}
            </>
          )}
          <div className="mt-1 border-t border-surface-700/60 pt-1">
            <SessionReasoningSelector variant="model-menu" onComplete={() => setOpen(false)} />
          </div>
    </>
  );

  const currentCompany = getModelCompany(current);

  return (
    <>
    {pendingSwitch && createPortal(
      <EngineSwitchConfirmModal
        fromEngine={pendingSwitch.fromEngine}
        toEngine={pendingSwitch.toEngine}
        busy={switchBusy}
        errorMessage={switchError}
        onConfirm={handleConfirmSwitch}
        onCancel={handleCancelSwitch}
      />,
      document.body,
    )}
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={variant === 'composer'
          ? 'flex max-w-[190px] items-center gap-1 rounded px-1 py-0.5 text-[11px] text-surface-500 transition-colors hover:bg-surface-700/45 hover:text-surface-300'
          : 'flex items-center gap-1.5 rounded-md border border-surface-700/50 bg-surface-800/80 px-2.5 py-1 text-[13px] font-medium text-gray-400 shadow-sm transition-all hover:bg-surface-800 hover:text-gray-300'
        }
        aria-expanded={open}
      >
        <span className="truncate">{getModelDisplayName(current, t)}</span>
        {currentCompany && <span className="shrink-0 text-surface-600">· {currentCompany}</span>}
        <svg className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (variant === 'composer' ? (menuPosition && menuPosition.maxHeight > 0 ? createPortal(
        <div
          ref={menuRef}
          style={{ top: menuPosition.top, bottom: menuPosition.bottom, right: menuPosition.right, maxHeight: menuPosition.maxHeight }}
          className="fixed z-[40] w-[320px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-surface-700 bg-surface-900 py-1.5 shadow-2xl shadow-black/40"
        >
          {menuContent}
        </div>, document.body) : null) : (
        <div
          ref={menuRef}
          className={`absolute right-0 z-[100] max-h-[70vh] w-[320px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-surface-700 bg-surface-900 py-1.5 shadow-2xl shadow-black/40 animate-in fade-in duration-150 ${
            dropdownAlign === 'up'
              ? 'bottom-full mb-1 slide-in-from-bottom-1'
              : 'top-full mt-1 slide-in-from-top-1'
          }`}
        >
          {menuContent}

        </div>
      ))}
    </div>
    </>
  );
}
