// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MESSAGE_BUBBLE_PATH = path.resolve(__dirname, 'MessageBubble.tsx');
const RICH_CONTENT_PATH = path.resolve(__dirname, '../shared/RichContent.tsx');

describe('mobile message width source guards', () => {
  it('keeps each message row and assistant body inside the mobile viewport width', () => {
    const src = fs.readFileSync(MESSAGE_BUBBLE_PATH, 'utf-8');

    expect(src).toContain('flex min-w-0 max-w-full gap-3');
    expect(src).toContain('flex min-w-0 max-w-full flex-col md:flex-row');
    expect(src).toContain("'min-w-0 w-full max-w-full overflow-hidden md:flex-1'");
    expect(src).toContain('className="relative min-w-0 max-w-full space-y-2"');
  });

  it('constrains markdown segments without disabling their internal code and table scrolling', () => {
    const src = fs.readFileSync(RICH_CONTENT_PATH, 'utf-8');

    expect(src).toContain('prose prose-sm min-w-0 w-full max-w-full overflow-hidden break-words');
    expect(src).toContain('className="relative group/code my-2 max-w-none overflow-x-auto');
  });
});
