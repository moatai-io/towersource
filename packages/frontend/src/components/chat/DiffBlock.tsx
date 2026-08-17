import { useMemo, useState } from 'react';
import { useSettingsStore } from '../../stores/settings-store';
import { parseLooseJson, safeStr } from '../shared/parse-loose-json';
import { BlockFallback } from '../shared/RichContent';

interface DiffSpec {
  title?: string;
  mode?: 'split' | 'unified';
  language?: string;
  before: string;
  after: string;
}

interface DiffLine {
  type: 'add' | 'remove' | 'same';
  content: string;
  oldNum?: number;
  newNum?: number;
}

interface Props {
  raw: string;
  fallbackCode: string;
}

function computeDiff(before: string, after: string): DiffLine[] {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  // Simple LCS-based diff
  const m = oldLines.length, n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack
  const result: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: 'same', content: oldLines[i - 1], oldNum: i, newNum: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'add', content: newLines[j - 1], newNum: j });
      j--;
    } else {
      result.push({ type: 'remove', content: oldLines[i - 1], oldNum: i });
      i--;
    }
  }
  result.reverse();
  return result;
}

/**
 * Detect a unified-diff-style payload. LLMs and users often write ```diff
 * blocks with raw `+`/`-`/` ` line prefixes (sometimes with @@ hunk headers,
 * sometimes not), which breaks the JSON parser. Fall back to rendering those
 * directly so the block doesn't throw "Unexpected token '<'".
 */
function isUnifiedDiff(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^(---\s|\+\+\+\s|@@\s|diff --git |Index: )/m.test(trimmed)) return true;
  // Fallback: most non-empty lines are +/-/space prefixed
  const lines = trimmed.split('\n').filter((l) => l.length > 0).slice(0, 20);
  if (lines.length < 2) return false;
  const prefixed = lines.filter((l) => /^[+\- ]/.test(l)).length;
  return prefixed / lines.length > 0.6;
}

/**
 * Did the author plausibly *intend* a diff/JSON in this block? Used to
 * decide whether a parse failure should surface an error or silently
 * render as plain code.
 *
 * Accepts as "intended":
 *   - Anything starting with `{` (looks like JSON spec)
 *   - Any line starting with `+` or `-` (some attempt at a unified diff)
 *   - Hunk-style markers (`@@`, `--- a/`, `+++ b/`, `diff --git`)
 *
 * Rejects (→ silent plain-code fallback):
 *   - Prose / checklists with ✅ / ❌ / bullets that the AI tagged as
 *     ```diff for visual emphasis. The JSON error message
 *     ("Unexpected token '✅' …") is misleading noise here — the user
 *     never intended JSON.
 */
function looksLikeDiffAttempt(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('{')) return true;
  if (/^(---\s|\+\+\+\s|@@\s|diff --git |Index: )/m.test(trimmed)) return true;
  if (/^[+\-]/m.test(trimmed)) return true;
  return false;
}

function parseUnifiedDiff(raw: string): DiffLine[] {
  const result: DiffLine[] = [];
  let oldNum = 1;
  let newNum = 1;
  for (const line of raw.split('\n')) {
    // File headers / git markers — skip
    if (/^(---\s|\+\+\+\s|diff --git |index |Index: |new file mode|deleted file mode|similarity index|rename from|rename to)/.test(line)) {
      continue;
    }
    // Hunk header: @@ -1,4 +2,6 @@
    const hunk = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      oldNum = parseInt(hunk[1], 10);
      newNum = parseInt(hunk[2], 10);
      continue;
    }
    if (line.startsWith('+')) {
      result.push({ type: 'add', content: line.slice(1), newNum: newNum++ });
    } else if (line.startsWith('-')) {
      result.push({ type: 'remove', content: line.slice(1), oldNum: oldNum++ });
    } else if (line.startsWith(' ')) {
      result.push({ type: 'same', content: line.slice(1), oldNum: oldNum++, newNum: newNum++ });
    } else if (line.length === 0 && result.length > 0) {
      // Blank line inside a hunk — treat as unchanged
      result.push({ type: 'same', content: '', oldNum: oldNum++, newNum: newNum++ });
    }
    // Anything else: ignore (noise line)
  }
  return result;
}

export default function DiffBlock({ raw, fallbackCode }: Props) {
  const theme = useSettingsStore((s) => s.theme);
  const isDark = theme !== 'light';
  const [mode, setMode] = useState<'split' | 'unified'>('unified');

  const parsed = useMemo(() => {
    // Path 1: JSON spec { before, after, ... }
    const r = parseLooseJson(raw);
    if (r.ok) {
      const spec = r.data as DiffSpec;
      if (spec.before != null && spec.after != null) {
        return { ok: true as const, spec, preDiff: undefined as DiffLine[] | undefined };
      }
    }
    // Path 2: raw unified-diff text — parse directly into DiffLine[]
    if (isUnifiedDiff(raw)) {
      const preDiff = parseUnifiedDiff(raw);
      if (preDiff.length > 0) {
        return {
          ok: true as const,
          spec: { before: '', after: '' } as DiffSpec,
          preDiff,
        };
      }
    }
    return {
      ok: false as const,
      error: r.ok ? 'Missing "before" and/or "after"' : r.error,
    };
  }, [raw]);

  const diff = useMemo(() => {
    if (!parsed.ok) return [];
    if (parsed.preDiff) return parsed.preDiff;
    return computeDiff(parsed.spec.before, parsed.spec.after);
  }, [parsed]);

  if (!parsed.ok) {
    // Distinguish "user attempted a diff/JSON and made a typo" (show the
    // parse error so they can fix it) from "user/AI tagged ```diff for
    // visual emphasis on prose ✅ / ❌ checklists" (silently render as
    // plain code, no error noise — the JSON parse error is misleading
    // since the user never intended JSON).
    if (looksLikeDiffAttempt(raw)) {
      return <BlockFallback raw={fallbackCode} error={parsed.error} />;
    }
    return (
      <pre className="my-2 bg-surface-900/60 border border-surface-700/40 rounded-lg p-4 overflow-x-auto text-base">
        <code className="whitespace-pre-wrap">{raw}</code>
      </pre>
    );
  }
  const { spec } = parsed;
  const displayMode = spec.mode || mode;

  const addColor = 'tone-success tone-bg-soft';
  const removeColor = isDark ? 'bg-red-900/30' : 'bg-red-50';
  const addText = 'tone-success tone-text';
  const removeText = isDark ? 'text-red-300' : 'text-red-700';
  const numColor = isDark ? 'text-gray-600' : 'text-gray-400';

  return (
    <div className="my-3 rounded-lg border border-surface-700/40 bg-surface-900/40 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-800/40 border-b border-surface-700/30">
        <div className="flex items-center gap-2">
          <span className="text-[12px] uppercase tracking-wider text-gray-500 font-medium">Diff</span>
          {spec.title && <span className="text-sm text-gray-400">{spec.title}</span>}
          {spec.language && <span className="text-[12px] px-1.5 py-0.5 rounded bg-surface-700/50 text-gray-500">{spec.language}</span>}
        </div>
        <div className="flex gap-0.5 bg-surface-800/60 rounded p-0.5">
          {(['unified', 'split'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`text-[12px] px-2 py-0.5 rounded transition-colors ${
                displayMode === m
                  ? (isDark ? 'bg-surface-600 text-gray-200' : 'bg-white text-gray-700 shadow-sm')
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto text-sm font-mono">
        {displayMode === 'unified' ? (
          <table className="w-full">
            <tbody>
              {diff.map((line, i) => (
                <tr key={i} className={line.type === 'add' ? addColor : line.type === 'remove' ? removeColor : ''}>
                  <td className={`px-2 py-0 w-8 text-right select-none ${numColor}`}>
                    {line.oldNum ?? ''}
                  </td>
                  <td className={`px-2 py-0 w-8 text-right select-none ${numColor}`}>
                    {line.newNum ?? ''}
                  </td>
                  <td className="px-1 py-0 w-4 select-none text-center">
                    {line.type === 'add' ? <span className={addText}>+</span>
                     : line.type === 'remove' ? <span className={removeText}>-</span>
                     : <span className="text-gray-700"> </span>}
                  </td>
                  <td className={`px-2 py-0 whitespace-pre ${
                    line.type === 'add' ? addText : line.type === 'remove' ? removeText : (isDark ? 'text-gray-300' : 'text-gray-700')
                  }`}>
                    {safeStr(line.content)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          /* Split view */
          <div className="flex">
            <div className="flex-1 border-r border-surface-700/30">
              <table className="w-full">
                <tbody>
                  {diff.filter(l => l.type !== 'add').map((line, i) => (
                    <tr key={i} className={line.type === 'remove' ? removeColor : ''}>
                      <td className={`px-2 py-0 w-8 text-right select-none ${numColor}`}>
                        {line.oldNum ?? ''}
                      </td>
                      <td className={`px-2 py-0 whitespace-pre ${
                        line.type === 'remove' ? removeText : (isDark ? 'text-gray-300' : 'text-gray-700')
                      }`}>
                        {safeStr(line.content)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex-1">
              <table className="w-full">
                <tbody>
                  {diff.filter(l => l.type !== 'remove').map((line, i) => (
                    <tr key={i} className={line.type === 'add' ? addColor : ''}>
                      <td className={`px-2 py-0 w-8 text-right select-none ${numColor}`}>
                        {line.newNum ?? ''}
                      </td>
                      <td className={`px-2 py-0 whitespace-pre ${
                        line.type === 'add' ? addText : (isDark ? 'text-gray-300' : 'text-gray-700')
                      }`}>
                        {safeStr(line.content)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
