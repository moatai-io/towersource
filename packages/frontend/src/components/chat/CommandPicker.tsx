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
  // Skill argument hints tend to be author-facing contract details (`[path]`,
  // `[create|audit]`) unless the skill has explicitly provided a picker summary.
  // Keep them searchable, but avoid leading with them in the visual picker fallback.
  const shouldShowHint = Boolean(cmd.argumentHint && (cmd.summary || cmd.source !== 'skills'));
  return shouldShowHint ? `${cmd.argumentHint} — ${body}` : body;
}

export function CommandPicker({
  commands,
  selectedIndex,
  onSelect,
  onHover,
}: {
  commands: SlashCommandInfo[];
  selectedIndex: number;
  onSelect: (commandText: string) => void;
  onHover: (index: number) => void;
}) {
  if (commands.length === 0) return null;
  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 max-h-72 overflow-y-auto rounded-xl border border-surface-700/50 bg-surface-800/90 shadow-xl backdrop-blur-xl">
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
              <span className="shrink-0 font-mono text-primary-500/70 group-hover:text-primary-400">/</span>
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
              <span className={`ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${
                cmd.source === 'commands'
                  ? 'border border-blue-500/20 bg-blue-900/30 text-blue-400'
                  : cmd.source === 'skills'
                    ? 'border border-violet-500/20 bg-violet-900/30 text-violet-400'
                    : 'border border-surface-600/30 bg-surface-700/50 text-gray-500'
              }`}>
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
    </div>
  );
}
