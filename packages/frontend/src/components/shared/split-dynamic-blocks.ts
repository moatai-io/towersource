export const VISUAL_LANGUAGES = [
  'mermaid', 'chart', 'datatable', 'html-sandbox', 'svg', 'timeline', 'map', 'secure-input',
  'steps', 'diff', 'form', 'kanban', 'terminal', 'comparison',
  'treemap', 'gallery', 'audio', 'browser-popup', 'browser-live', 'cad-evidence',
] as const;

export type VisualLang = typeof VISUAL_LANGUAGES[number];
export type BlockType = 'text' | VisualLang;

export interface DynamicBlock {
  type: BlockType;
  content: string;
  raw: string;
}

const LANG_PATTERN = VISUAL_LANGUAGES.join('|');
const BLOCK_REGEX = new RegExp(
  '```(' + LANG_PATTERN + ')\\n([\\s\\S]*?)```',
  'g',
);

export function splitDynamicBlocks(text: string): DynamicBlock[] {
  const blocks: DynamicBlock[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(BLOCK_REGEX)) {
    if (match.index! > lastIndex) {
      const before = text.slice(lastIndex, match.index!).trim();
      if (before) blocks.push({ type: 'text', content: before, raw: before });
    }
    blocks.push({
      type: match[1] as VisualLang,
      content: match[2].trim(),
      raw: match[0],
    });
    lastIndex = match.index! + match[0].length;
  }

  if (lastIndex < text.length) {
    const rest = text.slice(lastIndex).trim();
    if (rest) blocks.push({ type: 'text', content: rest, raw: rest });
  }

  return blocks.length > 0 ? blocks : [{ type: 'text', content: text, raw: text }];
}
