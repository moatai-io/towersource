import { useLayoutEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { SlashCommandInfo } from '../../stores/chat-store';

export function commandNameFields(cmd: SlashCommandInfo): string[] {
  return [cmd.name, cmd.canonical, ...(cmd.aliases || [])]
    .filter(Boolean)
    .map((value) => String(value).toLocaleLowerCase());
}

function commandSearchFields(cmd: SlashCommandInfo): string[] {
  return [
    ...commandNameFields(cmd),
    cmd.displayName,
    cmd.summary,
    cmd.argumentHint,
    cmd.description,
  ].filter(Boolean).map((value) => String(value).toLocaleLowerCase());
}

function commandMatches(cmd: SlashCommandInfo, commandQuery: string): boolean {
  if (!commandQuery) return true;
  return commandSearchFields(cmd).some((value) => value.includes(commandQuery));
}

function commandRank(cmd: SlashCommandInfo, commandQuery: string): number {
  if (!commandQuery) return 100;
  const names = commandNameFields(cmd);
  if (names.some((value) => value === commandQuery)) return 0;
  if (names.some((value) => value.startsWith(commandQuery))) return 1;
  if (names.some((value) => value.includes(commandQuery))) return 2;
  const display = String(cmd.displayName || '').toLocaleLowerCase();
  if (display === commandQuery) return 3;
  if (display.startsWith(commandQuery)) return 4;
  return 10;
}

export function filterSlashCommands(commands: SlashCommandInfo[], input: string): SlashCommandInfo[] {
  const commandQuery = input.startsWith('/') ? input.slice(1).trim().toLocaleLowerCase() : '';
  return input.startsWith('/')
    ? [...commands]
      .filter((cmd) => commandMatches(cmd, commandQuery))
      .sort((a, b) => commandRank(a, commandQuery) - commandRank(b, commandQuery) || a.name.localeCompare(b.name))
    : [];
}

export function hasExactCommandMatch(input: string, commands: SlashCommandInfo[]): boolean {
  const commandQuery = input.startsWith('/') ? input.slice(1).trim().toLocaleLowerCase() : '';
  const commandHead = commandQuery.split(/\s+/)[0] || '';
  return input.startsWith('/') && commands.some((cmd) =>
    commandNameFields(cmd).some((name) => name === commandQuery || name === commandHead),
  );
}

export function commandIdentityKey(commands: SlashCommandInfo[]): string {
  return commands.map((cmd) => `${cmd.canonical || cmd.name}:${cmd.source}:${cmd.scope || ''}`).join('|');
}

function scopeLabel(scope?: SlashCommandInfo['scope']) {
  if (scope === 'personal') return 'my';
  if (scope === 'project') return 'proj';
  if (scope === 'company') return 'co';
  if (scope === 'system') return 'sys';
  return '';
}

function kindLabel(cmd: SlashCommandInfo) {
  if (cmd.kind === 'workflow') return 'flow';
  if (cmd.kind === 'native') return 'cmd';
  if (cmd.source === 'commands') return 'cmd';
  if (cmd.source === 'skills') return 'skill';
  return 'sdk';
}

function kindGlyph(cmd: SlashCommandInfo) {
  if (cmd.kind === 'skill' || cmd.source === 'skills') return '✦';
  if (cmd.kind === 'workflow' || cmd.source === 'workflow') return '▶';
  return '›_';
}

function kindTone(cmd: SlashCommandInfo) {
  if (cmd.kind === 'skill' || cmd.source === 'skills') return 'border-violet-500/20 bg-violet-900/30 text-violet-400';
  if (cmd.kind === 'workflow' || cmd.source === 'workflow') return 'border-amber-500/20 bg-amber-900/30 text-amber-400';
  return 'border-blue-500/20 bg-blue-900/30 text-blue-400';
}

function compactFallbackDescription(description?: string): string {
  if (!description) return '';
  const firstUsefulSegment = description
    .replace(/\s+/g, ' ')
    .split(/\b(?:Use when|NOT for|Triggers?|Actions?|Modes?|Companion to)\s*:/i)[0]
    .trim();
  return firstUsefulSegment.length > 140 ? `${firstUsefulSegment.slice(0, 139)}…` : firstUsefulSegment;
}

function pickerDetailText(cmd: SlashCommandInfo): string {
  const body = cmd.summary || compactFallbackDescription(cmd.description);
  if (!body) return '';
  const shouldShowHint = Boolean(cmd.argumentHint && (cmd.summary || cmd.source !== 'skills'));
  return shouldShowHint ? `${cmd.argumentHint} — ${body}` : body;
}

interface PickerPosition {
  left: number;
  width: number;
  bottom: number;
  maxHeight: number;
}

export function CommandPicker({
  commands,
  selectedIndex,
  onSelect,
  onHover,
  anchorRef,
}: {
  commands: SlashCommandInfo[];
  selectedIndex: number;
  onSelect: (commandText: string) => void;
  onHover: (index: number) => void;
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const [position, setPosition] = useState<PickerPosition | null>(null);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      const availableAbove = Math.max(160, rect.top - 12);
      setPosition({
        left: rect.left,
        width: rect.width,
        bottom: Math.max(8, viewportHeight - rect.top + 8),
        maxHeight: Math.min(768, Math.floor(availableAbove * 0.92)),
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    window.visualViewport?.addEventListener('resize', updatePosition);
    window.visualViewport?.addEventListener('scroll', updatePosition);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      window.visualViewport?.removeEventListener('resize', updatePosition);
      window.visualViewport?.removeEventListener('scroll', updatePosition);
    };
  }, [anchorRef]);

  if (commands.length === 0 || !position || typeof document === 'undefined') return null;
  return createPortal(
    <div
      data-testid="slash-command-picker"
      className="fixed z-[1000] overflow-y-auto overscroll-contain rounded-xl border border-surface-700/50 bg-surface-800/95 shadow-2xl backdrop-blur-xl"
      style={{ left: position.left, width: position.width, bottom: position.bottom, maxHeight: position.maxHeight }}
    >
      {commands.map((cmd, idx) => {
        const commandText = cmd.canonical || cmd.name;
        const detailText = pickerDetailText(cmd);
        return (
          <button
            key={`${commandText}:${cmd.source}:${cmd.scope || ''}`}
            className={`group w-full px-4 py-2.5 text-left text-base text-gray-300 transition-colors hover:bg-surface-700/50 hover:text-white ${
              idx === selectedIndex ? 'bg-surface-700/50 text-white' : ''
            }`}
            onClick={() => onSelect(commandText)}
            onMouseEnter={() => onHover(idx)}
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md border px-1 font-mono text-[11px] font-semibold ${kindTone(cmd)}`}
              >
                {kindGlyph(cmd)}
              </span>
              <span className="truncate font-medium">{commandText}</span>
              {cmd.displayName && cmd.displayName !== commandText && (
                <span className="truncate text-[12px] text-gray-500">{cmd.displayName}</span>
              )}
              {cmd.scope && (
                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${
                  cmd.scope === 'personal'
                    ? 'border border-blue-500/20 bg-blue-900/30 text-blue-400'
                    : cmd.scope === 'project'
                      ? 'tone-pill tone-success'
                      : 'tone-pill tone-warning'
                }`}>
                  {scopeLabel(cmd.scope)}
                </span>
              )}
              <span className={`ml-auto shrink-0 rounded-full border px-1.5 py-0.5 text-[11px] font-medium ${kindTone(cmd)}`}>
                {kindLabel(cmd)}
              </span>
            </div>
            {detailText && (
              <div className="mt-0.5 truncate pl-5 text-[13px] text-gray-500">
                {detailText}
              </div>
            )}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
