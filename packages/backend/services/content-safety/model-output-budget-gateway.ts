// Owns the final bounded shape of file-tool results before they become model-visible.
// Format-specific tools parse/render; this module caps text, image count, and inline bytes.

import { sanitizeEmbeddedBinaryText } from './embedded-binary.js';

export interface ModelOutputBudget {
  maxTextChars: number;
  maxImages: number;
  maxImageBytes: number;
}

export interface BudgetedModelContentResult {
  content: any[];
  truncated: boolean;
  omittedImages: number;
  textChars: number;
  imageBytes: number;
}

export const DEFAULT_FILE_TOOL_OUTPUT_BUDGET: ModelOutputBudget = {
  maxTextChars: 20_000,
  maxImages: 12,
  maxImageBytes: 24 * 1024 * 1024,
};

function estimatedBase64Bytes(data: string): number {
  const normalized = data.replace(/\s/g, '');
  if (!normalized) return 0;
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

export function applyModelOutputBudget(
  input: readonly any[],
  budget: Partial<ModelOutputBudget> = {},
): BudgetedModelContentResult {
  const limits = { ...DEFAULT_FILE_TOOL_OUTPUT_BUDGET, ...budget };
  const content: any[] = [];
  let textChars = 0;
  let imageBytes = 0;
  let imageCount = 0;
  let omittedImages = 0;
  let truncated = false;

  for (const block of input) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const sanitized = sanitizeEmbeddedBinaryText(block.text);
      const remaining = Math.max(0, limits.maxTextChars - textChars);
      if (!remaining) {
        truncated = true;
        continue;
      }
      const fitted = sanitized.length > remaining ? `${sanitized.slice(0, Math.max(0, remaining - 42))}\n…[file tool output truncated by budget]` : sanitized;
      textChars += fitted.length;
      if (fitted.length < sanitized.length) truncated = true;
      content.push({ ...block, text: fitted });
      continue;
    }

    if (block?.type === 'image' && typeof block.data === 'string') {
      const bytes = estimatedBase64Bytes(block.data);
      if (imageCount >= limits.maxImages || imageBytes + bytes > limits.maxImageBytes) {
        omittedImages += 1;
        truncated = true;
        continue;
      }
      imageCount += 1;
      imageBytes += bytes;
      content.push(block);
      continue;
    }

    content.push(block);
  }

  if (omittedImages > 0) {
    content.push({
      type: 'text',
      text: `[${omittedImages} image(s) omitted by the shared model-output budget; request a smaller page/range selection.]`,
    });
  }

  return { content, truncated, omittedImages, textChars, imageBytes };
}
