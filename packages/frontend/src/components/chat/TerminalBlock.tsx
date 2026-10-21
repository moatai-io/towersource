import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { parseLooseJson, safeStr } from '../shared/parse-loose-json';
import { BlockFallback } from '../shared/RichContent';
import { splitFilePathsInText as splitTowerFilePathsInText } from '../../utils/file-path-links';

interface TerminalCommand {
  cmd: string;
  output?: string;
  status?: 'success' | 'error' | 'running';
}

interface TerminalSpec {
  title?: string;
  commands: TerminalCommand[];
}

interface Props {
  raw: string;
  fallbackCode: string;
  onFileClick?: (path: string) => void;
}

function renderOutputText(text: string, t: TFunction<'chat'>, onFileClick?: (path: string) => void) {
  if (!onFileClick) return text;
  const parts = splitTowerFilePathsInText(text, onFileClick, (filePath, key) => (
    <button
      key={key}
      type="button"
      className="inline cursor-pointer break-all underline transition-opacity hover:opacity-80"
      style={{
        color: 'var(--th-prose-link)',
        textDecorationColor: 'color-mix(in srgb, var(--th-prose-link) 40%, transparent)',
      }}
      title={t('openFile', { path: filePath })}
      onClick={(e) => {
        e.stopPropagation();
        onFileClick(filePath);
      }}
    >
      {filePath}
    </button>
  ));
  return parts.length > 0 ? parts : text;
}

export default function TerminalBlock({ raw, fallbackCode, onFileClick }: Props) {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const parsed = useMemo(() => {
    const r = parseLooseJson(raw);
    if (!r.ok) return { ok: false as const, error: r.error };
    const spec = r.data as TerminalSpec;
    if (!spec.commands || !Array.isArray(spec.commands)) return { ok: false as const, error: 'Missing "commands" array' };
    return { ok: true as const, spec };
  }, [raw]);

  if (!parsed.ok) return <BlockFallback raw={fallbackCode} error={parsed.error} />;
  const { spec } = parsed;

  const copyCmd = async (cmd: string, idx: number) => {
    await navigator.clipboard.writeText(cmd);
    setCopied(idx);
    setTimeout(() => setCopied(null), 1500);
  };

  const toggleCollapse = (idx: number) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  const statusColor = (s?: string) => {
    if (s === 'success') return 'tone-success tone-text';
    if (s === 'error') return 'tone-danger tone-text';
    if (s === 'running') return 'tone-warning tone-text animate-pulse';
    return 'text-gray-400';
  };

  return (
    <div className="my-3 rounded-lg border border-surface-700/40 bg-[#1a1b26] overflow-hidden font-mono text-sm">
      {/* Title bar */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[#16161e] border-b border-surface-700/30">
        <div className="flex gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
          <div className="w-2.5 h-2.5 rounded-full tone-warning tone-bg" />
          <div className="w-2.5 h-2.5 rounded-full tone-success tone-bg" />
        </div>
        <span className="text-[12px] text-gray-600 ml-2">{spec.title || t('terminal.title', { defaultValue: '터미널' })}</span>
      </div>

      <div className="p-2 space-y-1">
        {spec.commands.map((entry, i) => {
          const isCollapsed = collapsed.has(i);
          return (
            <div key={i}>
              {/* Command line */}
              <div className="flex items-center group">
                <span className="tone-accent tone-text mr-1.5 select-none">$</span>
                <span
                  className="text-gray-200 cursor-pointer hover:text-white flex-1"
                  onClick={() => copyCmd(entry.cmd, i)}
                  title={t('terminal.copyCommand', { defaultValue: '클릭하여 명령 복사' })}
                >
                  {safeStr(entry.cmd)}
                </span>
                {entry.status && (
                  <span className={`ml-2 text-[12px] ${statusColor(entry.status)}`}>
                    {entry.status === 'success' ? '✓' : entry.status === 'error' ? '✗' : '⟳'}
                  </span>
                )}
                {copied === i && (
                  <span className="ml-1 text-[11px] tone-success tone-text">{t('copied')}</span>
                )}
              </div>
              {/* Output */}
              {entry.output && (
                <div>
                  <button
                    onClick={() => toggleCollapse(i)}
                    className="text-[11px] text-gray-600 hover:text-gray-400 select-none mb-0.5"
                  >
                    {isCollapsed ? `▸ ${t('terminal.showOutput', { defaultValue: '출력 보기' })}` : `▾ ${t('terminal.hideOutput', { defaultValue: '출력 숨기기' })}`}
                  </button>
                  {!isCollapsed && (
                    <pre className={`whitespace-pre-wrap pl-4 ${
                      entry.status === 'error' ? 'text-red-300/80' : 'text-gray-500'
                    }`}>
                      {renderOutputText(safeStr(entry.output), t, onFileClick)}
                    </pre>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
