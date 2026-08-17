/**
 * Owns Pi message/content adaptation into Tower UI blocks.
 * Public API: ContentAccumulator, agentMessageToTowerBlocks.
 *
 * Keep this module pure: no provider, session, DB, or policy logic belongs here.
 */

import type { TowerContentBlock } from '../types.js';

// ═══════════════════════════════════════════════════════════════
// Tool input normalization: Pi uses `path`, Tower standard is `file_path`
// ═══════════════════════════════════════════════════════════════

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'read', 'write', 'edit']);

function normalizeToolInput(name: string, input: Record<string, any>): Record<string, any> {
  if (FILE_TOOLS.has(name) && input.path && !input.file_path) {
    return { ...input, file_path: input.path };
  }
  return input;
}

// ═══════════════════════════════════════════════════════════════
// ContentAccumulator: Pi delta → cumulative TowerContentBlock[]
// ═══════════════════════════════════════════════════════════════

export class ContentAccumulator {
  private blocks: TowerContentBlock[] = [];
  private currentTextIdx = -1;
  private currentThinkingIdx = -1;
  private currentCommentaryIdx = -1;
  private pendingOptimisticText = '';

  appendText(delta: string) {
    if (this.currentTextIdx >= 0 && this.blocks[this.currentTextIdx].type === 'text') {
      (this.blocks[this.currentTextIdx] as any).text += delta;
    } else {
      this.currentTextIdx = this.blocks.length;
      this.currentThinkingIdx = -1;
      this.currentCommentaryIdx = -1;
      this.blocks.push({ type: 'text', text: delta });
    }
  }

  appendCommentary(delta: string) {
    if (!delta) return;
    if (this.currentCommentaryIdx >= 0 && this.blocks[this.currentCommentaryIdx].type === 'commentary') {
      (this.blocks[this.currentCommentaryIdx] as any).text = `${(this.blocks[this.currentCommentaryIdx] as any).text || ''}${delta}`;
    } else {
      this.currentCommentaryIdx = this.blocks.length;
      this.currentTextIdx = -1;
      this.currentThinkingIdx = -1;
      this.blocks.push({ type: 'commentary', text: delta, phase: 'commentary', visibility: 'progress' });
    }
  }

  appendOptimisticText(delta: string) {
    this.pendingOptimisticText += delta;
    const pending = this.pendingOptimisticText;
    const trimmed = pending.trim();
    // Responses phase can be delayed until text_end. To keep streaming natural,
    // show unknown-phase text optimistically, but hold ASCII scratchpad-shaped
    // prefixes (e.g. "Need query.", "We need inspect...") until text_end can
    // confirm whether they were hidden commentary. Korean/non-ASCII prose and
    // normal English prose stream immediately.
    const stillLooksLikeScratchpad = isInternalScratchpadPrefix(trimmed);
    if (stillLooksLikeScratchpad) return;
    this.appendText(pending);
    this.pendingOptimisticText = '';
  }

  appendThinking(_delta: string) {
    // Do not expose raw model reasoning / chain-of-thought. A thinking block is
    // a UI signal only: it lets Tower show the familiar thinking chip while the
    // actual private reasoning text stays out of user-visible content.
    if (this.currentThinkingIdx >= 0 && this.blocks[this.currentThinkingIdx].type === 'thinking') return;
    this.currentThinkingIdx = this.blocks.length;
    this.currentTextIdx = -1;
    this.currentCommentaryIdx = -1;
    this.blocks.push({ type: 'thinking', text: '' });
  }

  addToolUse(toolCall: { id: string; name: string; arguments: Record<string, any> }) {
    this.currentTextIdx = -1;
    this.currentThinkingIdx = -1;
    this.currentCommentaryIdx = -1;
    this.blocks.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.name,
      input: normalizeToolInput(toolCall.name, toolCall.arguments),  // Pi: arguments → Tower: input (normalized)
    });
  }

  replaceAll(blocks: TowerContentBlock[]) {
    this.pendingOptimisticText = '';
    this.blocks = blocks.map(b => ({ ...b }));
    this.currentTextIdx = -1;
    this.currentThinkingIdx = -1;
    this.currentCommentaryIdx = -1;
    const last = this.blocks[this.blocks.length - 1];
    if (last?.type === 'text') this.currentTextIdx = this.blocks.length - 1;
    if (last?.type === 'thinking') this.currentThinkingIdx = this.blocks.length - 1;
    if (last?.type === 'commentary') this.currentCommentaryIdx = this.blocks.length - 1;
  }

  toTowerBlocks(): TowerContentBlock[] {
    // Return deep-ish copy to avoid mutation issues. Some non-Responses bridges
    // can surface model reasoning as literal <think>...</think> text instead of
    // structured reasoning blocks. Streaming deltas do not carry phase metadata,
    // so keep this as a conservative fallback for accumulator-only paths.
    return sanitizePiVisibleBlocks(normalizeInlineThinkingTags(this.blocks.map(b => ({ ...b }))));
  }
}

const THINKING_TAG_RE = /<\/?(?:antml_)?thinking>|<\/?think>/gi;
const THINKING_OPEN_RE = /<(?:antml_)?thinking>|<think>/i;
const THINKING_CLOSE_RE = /<\/(?:antml_)?thinking>|<\/think>/i;

function pushTextBlock(out: TowerContentBlock[], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.type === 'text') {
    (last as any).text += text;
  } else {
    out.push({ type: 'text', text });
  }
}

function pushThinkingBlock(out: TowerContentBlock[], _text: string) {
  // Keep only the signal that thinking happened. Raw thinking text is never
  // copied into Tower content blocks.
  const last = out[out.length - 1];
  if (last?.type === 'thinking') return;
  out.push({ type: 'thinking', text: '' });
}

type TextOrThinkingBlock = Extract<TowerContentBlock, { type: 'text' | 'thinking' }>;

function isInsideMarkdownCode(text: string, index: number): boolean {
  let inFence = false;
  let inInline = false;
  for (let i = 0; i < index; i++) {
    if (text.startsWith('```', i)) {
      inFence = !inFence;
      i += 2;
      continue;
    }
    if (!inFence && text[i] === '`') {
      inInline = !inInline;
    }
  }
  return inFence || inInline;
}

function splitTextByInlineThinkingTags(text: string): TextOrThinkingBlock[] {
  const out: TextOrThinkingBlock[] = [];
  let mode: 'text' | 'thinking' = 'text';
  let cursor = 0;
  THINKING_TAG_RE.lastIndex = 0;

  for (let match = THINKING_TAG_RE.exec(text); match; match = THINKING_TAG_RE.exec(text)) {
    if (isInsideMarkdownCode(text, match.index)) continue;

    const chunk = text.slice(cursor, match.index);
    // Inline <think>...</think> is not a separate paragraph; it is hidden text
    // inside one text block. Drop its body without inserting a thinking block so
    // surrounding prose joins at the original position instead of via \n\n.
    if (mode !== 'thinking') pushTextBlock(out, chunk);

    const tag = match[0];
    if (THINKING_OPEN_RE.test(tag)) mode = 'thinking';
    else if (THINKING_CLOSE_RE.test(tag)) mode = 'text';
    cursor = match.index + tag.length;
  }

  const tail = text.slice(cursor);
  if (mode !== 'thinking') pushTextBlock(out, tail);
  return out;
}

function normalizeInlineThinkingTags(blocks: TowerContentBlock[]): TowerContentBlock[] {
  const out: TowerContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && THINKING_OPEN_RE.test(block.text)) {
      for (const split of splitTextByInlineThinkingTags(block.text)) {
        if (split.type === 'thinking') pushThinkingBlock(out, split.text);
        else pushTextBlock(out, split.text);
      }
      continue;
    }
    if (block.type === 'text') pushTextBlock(out, block.text);
    else if (block.type === 'thinking') pushThinkingBlock(out, block.text);
    else out.push({ ...block });
  }
  return out;
}

function isInternalScratchpadText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 800) return false;
  // Pi can leak internal planning fragments as ordinary text right before
  // tool calls (e.g. "Need query.", "Need run tests."). Keep this conservative:
  // ASCII-only and explicitly scratchpad-shaped. Korean/non-ASCII prose is more
  // likely user-facing, even if a provider mislabeled it as commentary.
  if (/[^\x00-\x7F]/.test(trimmed)) return false;
  return /^(Need(?:\s|$)|Need\b|Now\b|We need\b|I need\b|Need maybe\b|Need final\b|Need query\b|Need run\b|Need update\b)/i.test(trimmed);
}

function isInternalScratchpadPrefix(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/[^\x00-\x7F]/.test(trimmed)) return false;
  return /^(Need(?:\s|$)|Now\b|We need\b|I need\b)/i.test(trimmed);
}

function textSimilarity(a: string, b: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return 0;
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  if (longer.includes(shorter.slice(0, Math.min(shorter.length, 160)))) return shorter.length / longer.length;
  let samePrefix = 0;
  while (samePrefix < shorter.length && left[samePrefix] === right[samePrefix]) samePrefix++;
  return samePrefix / Math.max(longer.length, 1);
}

export function sanitizePiVisibleBlocks(blocks: TowerContentBlock[]): TowerContentBlock[] {
  const hasToolUse = blocks.some((b) => b.type === 'tool_use');
  const withoutPrivate = blocks.filter((block) => {
    if (block.type === 'thinking') return false;
    if (block.type === 'commentary') {
      const text = block.text?.trim() || '';
      return block.visibility === 'progress' && !!text && !isInternalScratchpadText(text);
    }
    // Legacy/non-Responses fallback only. Structured Responses commentary is
    // modeled as `commentary` above and classified before this sanitizer.
    if (hasToolUse && block.type === 'text' && isInternalScratchpadText(block.text)) return false;
    return true;
  });

  const out: TowerContentBlock[] = [];
  for (const block of withoutPrivate) {
    if (block.type !== 'text') {
      out.push({ ...block });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.type === 'text') {
      const similarity = textSimilarity(last.text, block.text);
      if (similarity > 0.55) {
        // Streaming sometimes leaves a draft-like text block followed by a final
        // text block with the same answer. Prefer the later/final block.
        out[out.length - 1] = { type: 'text', text: block.text };
      } else {
        (last as any).text += `\n\n${block.text}`;
      }
    } else {
      out.push({ type: 'text', text: block.text });
    }
  }
  return out;
}

export function parseTextSignaturePhase(block: any): string | undefined {
  if (typeof block?.textSignature !== 'string') return undefined;
  try {
    const parsed = JSON.parse(block.textSignature);
    return typeof parsed?.phase === 'string' ? parsed.phase : undefined;
  } catch {
    return undefined;
  }
}

export function agentMessageToTowerBlocks(message: any): TowerContentBlock[] {
  if (!Array.isArray(message?.content)) return [];
  const blocks = message.content.flatMap((block: any) => {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const phase = parseTextSignaturePhase(block);
      // LiteLLM/Codex-LB preserves Pi/OpenAI Responses text phases in
      // textSignature. `final_answer` is normal assistant prose. `commentary`
      // is Codex's preamble/progress channel: show human-readable progress, but
      // keep short ASCII scratchpad-shaped fragments hidden.
      // If phase is missing, keep the legacy/non-Responses fallback that strips
      // raw inline thinking tags.
      if (phase === 'final_answer') {
        return [{ type: 'text', text: block.text } satisfies TowerContentBlock];
      }
      if (phase === 'commentary') {
        const text = typeof block.text === 'string' ? block.text : '';
        const hidden = isInternalScratchpadText(text);
        return [{
          type: 'commentary',
          text: hidden ? '' : text,
          phase: 'commentary',
          visibility: hidden ? 'hidden' : 'progress',
        } satisfies TowerContentBlock];
      }
      if (phase) {
        return [{ type: 'commentary', text: '', phase: 'commentary', visibility: 'hidden' } satisfies TowerContentBlock];
      }
      return splitTextByInlineThinkingTags(block.text);
    }
    if (block?.type === 'thinking' && typeof block.thinking === 'string') {
      return [{ type: 'thinking', text: '' } satisfies TowerContentBlock];
    }
    if (block?.type === 'toolCall' && block.id && block.name) {
      return [{
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: normalizeToolInput(block.name, block.arguments || {}),
      } satisfies TowerContentBlock];
    }
    return [];
  });
  return sanitizePiVisibleBlocks(blocks);
}

