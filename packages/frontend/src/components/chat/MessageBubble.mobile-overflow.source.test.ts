// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MESSAGE_BUBBLE_PATH = path.resolve(__dirname, 'MessageBubble.tsx');
const CHAT_PANEL_PATH = path.resolve(__dirname, 'ChatPanel.tsx');
const INPUT_BOX_PATH = path.resolve(__dirname, 'InputBox.tsx');
const APP_PATH = path.resolve(__dirname, '../../App.tsx');
const RICH_CONTENT_PATH = path.resolve(__dirname, '../shared/RichContent.tsx');

describe('mobile message width source guards', () => {
  it('keeps each message row and assistant body inside the mobile viewport width', () => {
    const src = fs.readFileSync(MESSAGE_BUBBLE_PATH, 'utf-8');

    expect(src).toContain('flex min-w-0 max-w-full gap-3');
    expect(src).toContain('flex min-w-0 max-w-full flex-col md:flex-row');
    // Keep user actions in normal flow below a content-sized bubble. This
    // avoids both absolute overflow scrollbars and inflated short bubbles.
    expect(src).toContain("'min-w-0 max-w-[88%] overflow-hidden order-first'");
    expect(src).toContain("'min-w-0 w-full max-w-full overflow-hidden md:flex-1'");
    expect(src).toContain('className="relative min-w-0 max-w-full space-y-2"');
    expect(src).toContain('className="flex min-w-0 max-w-full flex-col items-end"');
    expect(src).toContain('ml-auto w-fit min-w-0 max-w-full overflow-hidden [overflow-wrap:anywhere] chat-user-bubble');
    expect(src).toContain('message-actions--user mt-1 flex min-h-11 w-max max-w-full');
    expect(src).not.toContain('md:min-w-[13rem]');
    expect(src).not.toContain('md:pb-14');
    expect(src).not.toContain('md:top-full');
    expect(src).not.toContain('md:absolute md:bottom-2');
  });

  it('prevents both chat list renderers from becoming horizontal scrollers', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('data-chat-scroll="plain"');
    expect(src).toContain('className="h-full min-w-0 max-w-full overflow-x-hidden overflow-y-auto"');
    expect(src).toContain('className="h-full min-w-0 max-w-full overflow-x-hidden"');
    expect(src).toContain('className="min-w-0 max-w-full overflow-x-hidden">{renderMessage(i)}</div>');
    expect(src).toContain('data-msg-id={mergedMessages[index]?.id} className="min-w-0 max-w-full overflow-x-hidden"');
  });

  it('keeps long composer drafts from expanding the split-pane shell', () => {
    const inputSrc = fs.readFileSync(INPUT_BOX_PATH, 'utf-8');
    const appSrc = fs.readFileSync(APP_PATH, 'utf-8');

    expect(inputSrc).toContain('relative min-w-0 w-full max-w-full');
    expect(inputSrc).not.toContain('relative min-w-0 w-full max-w-full overflow-x-hidden');
    expect(inputSrc).toContain('tower-input-shell relative z-10 min-w-0 max-w-full rounded-xl border');
    expect(inputSrc).not.toContain('tower-input-shell relative z-10 min-w-0 max-w-full overflow-x-hidden');
    expect(inputSrc).toContain('{showCommands && (');
    expect(inputSrc).toContain('<CommandPicker');
    expect(inputSrc).toContain('block min-w-0 w-full max-w-full overflow-x-hidden');
    expect(appSrc).toContain('tower-main-content-surface min-w-0 max-w-full flex-1 flex flex-col min-h-0 overflow-hidden');
  });

  it('constrains markdown segments without disabling their internal code and table scrolling', () => {
    const src = fs.readFileSync(RICH_CONTENT_PATH, 'utf-8');

    expect(src).toContain('prose prose-sm min-w-0 w-full max-w-full overflow-hidden break-words');
    expect(src).toContain('className="relative group/code my-2 max-w-none overflow-x-auto');
  });
});
