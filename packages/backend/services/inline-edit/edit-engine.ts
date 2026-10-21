// Owns: inline-edit AI invocation. Public API: runInlineEdit.
// See README.md.
//
// Wraps the engine-neutral utility agent for a single text→text round.
// Builds the labelled prompt, calls Sonnet 4.6 by default, and sanitizes the
// raw response so that callers can drop the result straight into the file.

import { runUtilityTextTask } from '../ai/utility-agent.js';
import { getModelDefaults, resolveLegacyPiModelId } from '../../config.js';
import {
  SYSTEM_PROMPT_TEXT,
  SYSTEM_PROMPT_HTML,
  SYSTEM_PROMPT_HTML_INSERT,
  buildUserPrompt,
  sanitizeReplacement,
  type SelectionKind,
  type EditMode,
} from './prompt.js';

/**
 * Pick the SYSTEM_PROMPT for this request. Insertion modes are HTML-only —
 * a text-mode insert is meaningless (selection-as-anchor doesn't fit
 * markdown's whitespace-delimited prose model), so we fall back to the
 * regular text prompt for kind='text' regardless of editMode.
 */
function getSystemPrompt(kind: SelectionKind, editMode: EditMode): string {
  if (kind === 'html') {
    return editMode === 'replace' ? SYSTEM_PROMPT_HTML : SYSTEM_PROMPT_HTML_INSERT;
  }
  return SYSTEM_PROMPT_TEXT;
}

export const DEFAULT_INLINE_EDIT_MODEL = 'litellm-responses/mini';

/** Hard caps to keep request size and latency predictable. */
export const LIMITS = {
  maxSelectionChars: 4_000,
  // Generous before/after window. With Sonnet 4.6's pricing this is ~1¢/1000
  // calls extra; the upside is much better tone matching on long documents.
  maxContextChars: 2_000,
  maxInstructionChars: 500,
} as const;

export interface InlineEditRequest {
  selection: string;
  beforeContext: string;
  afterContext: string;
  instruction: string;
  /** Model id (e.g. 'litellm-responses/mini'). Defaults to the AI reply default. */
  model?: string;
  /**
   * Selection kind — picks the SYSTEM_PROMPT.
   * - 'text' (default): plain text replacement (markdown / txt).
   * - 'html': raw HTML markup; allows structural edits.
   */
  selectionKind?: SelectionKind;
  /**
   * What the AI's output does to the selection.
   * - 'replace' (default): replace SELECTION verbatim.
   * - 'insertBefore' / 'insertAfter': SELECTION stays; output is glued in.
   * Insertion modes use the HTML inserter prompt.
   */
  editMode?: EditMode;
}

export interface InlineEditResult {
  replacement: string;
  /** Raw model output before sanitize, kept for debugging/audit only. */
  raw: string;
  model: string;
  durationMs: number;
}

/**
 * Run a single inline-edit round. Pure function over its inputs — no DB,
 * no fs, no audit (audit happens at the route layer where we know the user).
 *
 * Throws on hard limit violations so the route layer can return 400.
 */
export async function runInlineEdit(req: InlineEditRequest): Promise<InlineEditResult> {
  const selection = req.selection ?? '';
  const beforeContext = (req.beforeContext ?? '').slice(-LIMITS.maxContextChars);
  const afterContext = (req.afterContext ?? '').slice(0, LIMITS.maxContextChars);
  const instruction = (req.instruction ?? '').trim();
  const model = resolveLegacyPiModelId(req.model || getModelDefaults().ai_reply || DEFAULT_INLINE_EDIT_MODEL);

  if (!selection || !selection.trim()) {
    throw new Error('selection is empty');
  }
  if (selection.length > LIMITS.maxSelectionChars) {
    throw new Error(
      `selection too long (${selection.length} > ${LIMITS.maxSelectionChars} chars)`,
    );
  }
  if (!instruction) {
    throw new Error('instruction is empty');
  }
  if (instruction.length > LIMITS.maxInstructionChars) {
    throw new Error(
      `instruction too long (${instruction.length} > ${LIMITS.maxInstructionChars} chars)`,
    );
  }

  const kind: SelectionKind = req.selectionKind === 'html' ? 'html' : 'text';
  const editMode: EditMode =
    req.editMode === 'insertBefore' || req.editMode === 'insertAfter'
      ? req.editMode
      : 'replace';
  const systemPrompt = getSystemPrompt(kind, editMode);

  const userPrompt = buildUserPrompt({
    beforeContext,
    selection,
    afterContext,
    instruction,
    editMode,
  });

  const t0 = Date.now();
  // For insertion modes a "no change" output is the empty string (nothing
  // gets inserted), not the selection itself.
  const fallbackText = editMode === 'replace' ? selection : '';
  const raw = await runUtilityTextTask({
    prompt: userPrompt,
    systemPrompt,
    model,
    fallbackText,
  });
  const durationMs = Date.now() - t0;

  const replacement = sanitizeReplacement(raw, selection);

  return { replacement, raw, model, durationMs };
}
