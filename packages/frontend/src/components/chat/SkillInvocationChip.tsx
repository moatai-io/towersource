import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

export type SkillInvocationMeta = {
  skillName?: string;
  displayName?: string;
  trigger?: string;
  matchedAlias?: string;
  canonicalCommand?: string;
  source?: string;
  explicit?: boolean;
};

function triggerLabel(meta: SkillInvocationMeta, t: TFunction<'chat'>): string {
  if (meta.trigger === 'slash') return meta.matchedAlias || t('skillInvocation.slash', { defaultValue: '슬래시 명령' });
  if (meta.trigger === 'picker') return t('skillInvocation.picker', { defaultValue: '스킬 선택' });
  if (meta.trigger === 'natural-language') return t('skillInvocation.naturalLanguage', { defaultValue: '자연어 요청' });
  return meta.trigger || t('skillInvocation.skill', { defaultValue: '스킬' });
}

export function SkillInvocationChip({
  meta,
  align = 'right',
}: {
  meta?: SkillInvocationMeta | null;
  align?: 'left' | 'right';
}) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  if (!meta?.skillName && !meta?.displayName) return null;

  const label = meta.displayName || meta.skillName || t('skillInvocation.skill', { defaultValue: '스킬' });
  const trigger = triggerLabel(meta, t);
  const isNatural = meta.trigger === 'natural-language';

  return (
    <div className={`mt-1.5 flex ${align === 'left' ? 'justify-start' : 'justify-end'} px-1`}>
      <div className={`max-w-full ${align === 'right' ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className={`inline-flex max-w-[260px] items-center gap-1.5 rounded-md border px-2 py-0.5 text-[13px] transition-all duration-150 ${
            expanded
              ? 'border-violet-500/30 bg-violet-500/10 text-violet-300'
              : 'border-surface-700/40 bg-transparent text-gray-500 hover:border-violet-500/30 hover:bg-violet-500/10 hover:text-violet-300'
          }`}
          title={`Skill used: ${meta.skillName || label}${meta.matchedAlias ? ` via ${meta.matchedAlias}` : ''}`}
        >
          <svg className="h-3 w-3 shrink-0 text-violet-400 opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.22 3.756a1 1 0 00.95.69h3.95c.969 0 1.371 1.24.588 1.81l-3.196 2.322a1 1 0 00-.364 1.118l1.22 3.756c.3.921-.755 1.688-1.539 1.118l-3.196-2.322a1 1 0 00-1.176 0l-3.196 2.322c-.784.57-1.838-.197-1.539-1.118l1.22-3.756a1 1 0 00-.364-1.118L4.333 9.183c-.783-.57-.38-1.81.588-1.81h3.95a1 1 0 00.95-.69l1.228-3.756z" />
          </svg>
          <span className="truncate font-medium">Skill · {label}</span>
          <span className="shrink-0 text-violet-300/55">· {trigger}</span>
          <svg className={`h-3 w-3 shrink-0 opacity-50 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {expanded && (
          <div className="max-w-[320px] rounded-lg border border-violet-500/15 bg-surface-900/85 px-3 py-2 text-[12px] text-gray-400 shadow-lg">
            <div className="font-medium text-violet-300">{t('skillInvocation.applied', { name: label })}</div>
            <div className="mt-1 space-y-0.5">
              {meta.skillName && <div><span className="text-gray-500">{t('skillInvocation.name', { defaultValue: '이름' })}:</span> {meta.skillName}</div>}
              {meta.canonicalCommand && <div><span className="text-gray-500">{t('skillInvocation.command', { defaultValue: '명령' })}:</span> {meta.canonicalCommand}</div>}
              {meta.matchedAlias && <div><span className="text-gray-500">matched:</span> {meta.matchedAlias}</div>}
              {meta.source && <div><span className="text-gray-500">{t('skillInvocation.source', { defaultValue: '출처' })}:</span> {meta.source}</div>}
              <div><span className="text-gray-500">{t('skillInvocation.trigger', { defaultValue: '호출 방식' })}:</span> {trigger}</div>
              {isNatural && <div className="pt-1 text-violet-200/70">{t('skillInvocation.naturalSelection')}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
