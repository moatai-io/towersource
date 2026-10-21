import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settings-store';
import type { SlashCommandInfo } from '../../stores/chat-store';
import { ComposerConnectors } from './ComposerConnectors';

type Props = {
  commands: SlashCommandInfo[];
  onSelectSkill: (command: string) => void;
  onAttach: () => void;
  attachmentDisabled: boolean;
  projectId?: string | null;
  sessionId?: string | null;
};

/** Composer discovery only: selecting a skill inserts its existing slash command. */
export function ComposerCapabilitiesMenu({ commands, onSelectSkill, onAttach, attachmentDisabled, projectId, sessionId }: Props) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<'main' | 'skills' | 'connectors'>('main');
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const first = root.current?.querySelector<HTMLButtonElement>('[data-menu-content] button');
    first?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open, section]);
  useEffect(() => { setOpen(false); setSection('main'); setQuery(''); }, [sessionId, projectId]);
  const skills = commands.filter(command => command.source === 'skills' || command.kind === 'skill')
    .filter(command => `${command.name} ${command.description || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const row = 'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-surface-700/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:opacity-50';
  return <div ref={root} className="relative self-end" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <button ref={trigger} type="button" aria-label="파일·스킬·커넥터 추가" aria-expanded={open} aria-controls="composer-capabilities" onClick={() => { setSection('main'); setOpen(value => !value); }} className="m-0.5 rounded-xl p-2.5 text-surface-400 hover:bg-surface-700/45 hover:text-surface-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
    </button>
    {open && <div id="composer-capabilities" data-menu-content className="absolute bottom-full left-0 z-40 mb-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-surface-700 bg-surface-900 p-2 text-surface-100 shadow-xl" aria-label="대화 기능">
      {section === 'main' ? <>
        <button type="button" className={row} disabled={attachmentDisabled} onClick={() => { close(); onAttach(); }}>{t('attachFile', { defaultValue: '파일 추가' })}</button>
        <div className="my-1 border-t border-surface-700" />
        <button type="button" className={row} onClick={() => setSection('skills')}>스킬 <span aria-hidden="true">›</span></button>
        <button type="button" className={row} disabled={!projectId} onClick={() => setSection('connectors')}>커넥터 <span aria-hidden="true">›</span></button>
      </> : <>
        <button type="button" className={row} onClick={() => setSection('main')}>‹ {section === 'skills' ? '스킬' : '커넥터'}</button>
        {section === 'skills' ? <>
          <input aria-label="스킬 검색" value={query} onChange={event => setQuery(event.target.value)} placeholder="스킬 검색" className="my-2 w-full rounded-lg border border-surface-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-400" />
          <div className="max-h-64 overflow-y-auto">
            {skills.length ? skills.map(command => <button key={command.canonical || command.name} type="button" className={row} onClick={() => { close(); onSelectSkill(command.canonical || command.name); }}><span className="min-w-0"><span className="block truncate">{command.name.replace(/^\//, '')}</span>{command.description && <span className="mt-0.5 block truncate text-xs text-surface-400">{command.description}</span>}</span></button>) : <p className="px-3 py-4 text-sm text-surface-400">표시할 스킬이 없습니다.</p>}
          </div>
          <div className="my-1 border-t border-surface-700" />
          <button type="button" className={row} onClick={() => { close(); useSettingsStore.getState().setCapabilityProjectId(projectId || null); useSettingsStore.getState().setSkillsBrowserOpen(true); }}>스킬 둘러보기·관리</button>
        </> : <ComposerConnectors projectId={projectId!} sessionId={sessionId} />}
      </>}
    </div>}
  </div>;
}
