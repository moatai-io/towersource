import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sanitizeReplacement, buildUserPrompt, SYSTEM_PROMPT, SYSTEM_PROMPT_TEXT, SYSTEM_PROMPT_HTML, SYSTEM_PROMPT_HTML_INSERT } from './prompt.ts';

const mockRunUtilityTextTask = vi.fn();

describe('inline-edit prompt', () => {
  describe('SYSTEM_PROMPT', () => {
    it('forbids including context blocks in the response', () => {
      // The strict no-context rule is a load-bearing invariant — if it ever
      // gets softened, the model starts echoing surrounding text into files.
      expect(SYSTEM_PROMPT).toMatch(/NEVER include BEFORE_CONTEXT or AFTER_CONTEXT/);
    });
    it('instructs the model to leave selection unchanged on ambiguity', () => {
      expect(SYSTEM_PROMPT).toMatch(/output SELECTION unchanged/);
    });
    it('legacy SYSTEM_PROMPT alias still points at the text variant', () => {
      expect(SYSTEM_PROMPT).toBe(SYSTEM_PROMPT_TEXT);
    });
  });

  describe('SYSTEM_PROMPT_HTML', () => {
    it('declares isolation just like the text variant', () => {
      expect(SYSTEM_PROMPT_HTML).toMatch(/NO access to project files/);
      expect(SYSTEM_PROMPT_HTML).toMatch(/NEVER include BEFORE_CONTEXT or AFTER_CONTEXT/);
    });
    it('mandates tag balance — the load-bearing HTML invariant', () => {
      expect(SYSTEM_PROMPT_HTML).toMatch(/[Tt]ag balance/);
    });
    it('forbids markdown code fences in the response', () => {
      expect(SYSTEM_PROMPT_HTML).toMatch(/code fences/);
    });
    it('allows structural edits when the instruction asks for them', () => {
      // This is the key difference vs text mode: redesign permission.
      expect(SYSTEM_PROMPT_HTML).toMatch(/[Ss]tructural|[Rr]estructur|[Rr]edesign/);
    });
    it('defaults to preserving classes / attributes / indentation', () => {
      expect(SYSTEM_PROMPT_HTML).toMatch(/preserve existing tags|preserve existing markup/i);
    });
    it('falls back to SELECTION unchanged on ambiguity', () => {
      expect(SYSTEM_PROMPT_HTML).toMatch(/output SELECTION unchanged/);
    });
    it('explicitly enables deletion via empty output (regression for "버튼 없애줘" bug)', () => {
      // Without this rule the model conservatively returned SELECTION
      // unchanged, so deletion intents like "remove this button" silently
      // failed. Empty output is now the documented "delete" verb.
      expect(SYSTEM_PROMPT_HTML).toMatch(/[Dd]eletion is a valid edit/);
      expect(SYSTEM_PROMPT_HTML).toMatch(/output an empty string/);
    });
    it('forbids fragile asset references in HTML edits', () => {
      expect(SYSTEM_PROMPT_HTML).toMatch(/Portable assets/);
      expect(SYSTEM_PROMPT_HTML).toMatch(/file:\/\//);
      expect(SYSTEM_PROMPT_HTML).toMatch(/\/api\/files/);
      expect(SYSTEM_PROMPT_HTML_INSERT).toMatch(/Portable assets/);
    });
  });

  describe('buildUserPrompt', () => {
    it('emits all four labelled blocks in the documented order', () => {
      const out = buildUserPrompt({
        beforeContext: 'BEFORE',
        selection: 'SELECTION',
        afterContext: 'AFTER',
        instruction: 'INSTRUCTION',
      });
      const order = [
        out.indexOf('<<<BEFORE_CONTEXT>>>'),
        out.indexOf('<<<SELECTION>>>'),
        out.indexOf('<<<AFTER_CONTEXT>>>'),
        out.indexOf('<<<INSTRUCTION>>>'),
      ];
      expect(order.every((i, idx) => idx === 0 || i > order[idx - 1])).toBe(true);
      expect(out).toContain('SELECTION');
      expect(out).toContain('BEFORE');
      expect(out).toContain('AFTER');
      expect(out).toContain('INSTRUCTION');
    });
  });

  describe('sanitizeReplacement', () => {
    it('strips surrounding markdown code fences when the entire response is fenced', () => {
      const raw = '```\nclean text\n```';
      expect(sanitizeReplacement(raw, 'original')).toBe('clean text');
    });
    it('strips fenced response with language tag', () => {
      const raw = '```typescript\nconst x = 1;\n```';
      expect(sanitizeReplacement(raw, 'const y = 2;')).toBe('const x = 1;');
    });
    it('does NOT strip fences if they appear only inside the content', () => {
      // A real markdown body containing a code block must survive intact.
      const raw = 'before\n\n```js\ninner\n```\n\nafter';
      expect(sanitizeReplacement(raw, 'original')).toBe(raw);
    });
    it('strips a layer of surrounding double quotes when the original was not quoted', () => {
      expect(sanitizeReplacement('"hello"', 'world')).toBe('hello');
    });
    it('preserves quotes when the original selection was already quoted', () => {
      // If the user selected `"foo"` and asked to edit it, the AI returning
      // `"bar"` is correct — we must not strip the quotes.
      expect(sanitizeReplacement('"bar"', '"foo"')).toBe('"bar"');
    });
    it('strips Korean quote pairs', () => {
      expect(sanitizeReplacement('「안녕」', 'plain')).toBe('안녕');
    });
    it('strips common preambles like "Here is the rewritten text:"', () => {
      const raw = "Here's the rewritten text:\nactual content";
      expect(sanitizeReplacement(raw, 'original')).toBe('actual content');
    });
    it('does NOT strip preamble when content does not match the pattern', () => {
      const raw = 'Note: this is just a note about something.\nMore text.';
      expect(sanitizeReplacement(raw, 'original')).toBe(raw);
    });
    it('returns input unchanged for clean replacements', () => {
      const clean = '이 부분은 그대로 깔끔한 한국어 텍스트입니다.';
      expect(sanitizeReplacement(clean, 'something else')).toBe(clean);
    });
    it('strips ```html fence (HTML preview round-trip)', () => {
      const raw = '```html\n<p class="lead">강조된 단락</p>\n```';
      expect(sanitizeReplacement(raw, '<p>old</p>')).toBe('<p class="lead">강조된 단락</p>');
    });
    it('preserves inline HTML tags that are part of the replacement', () => {
      // The replacement is meant to contain real HTML; sanitize must not
      // touch <strong>...</strong> just because brackets exist.
      const raw = 'before <strong>중요</strong> after';
      expect(sanitizeReplacement(raw, 'plain')).toBe(raw);
    });
  });
});

describe('runInlineEdit', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock('../ai/utility-agent.js', () => ({
      runUtilityTextTask: mockRunUtilityTextTask,
    }));
  });

  it('calls utility-agent with the system prompt and labelled user prompt', async () => {
    mockRunUtilityTextTask.mockResolvedValueOnce('cleaned replacement');
    const { runInlineEdit } = await import('./edit-engine.ts');

    const result = await runInlineEdit({
      selection: 'old text',
      beforeContext: 'before',
      afterContext: 'after',
      instruction: 'make it formal',
    });

    expect(mockRunUtilityTextTask).toHaveBeenCalledTimes(1);
    const call = mockRunUtilityTextTask.mock.calls[0][0];
    expect(call.systemPrompt).toContain('NEVER include BEFORE_CONTEXT');
    expect(call.prompt).toContain('<<<SELECTION>>>');
    expect(call.prompt).toContain('old text');
    expect(call.prompt).toContain('make it formal');
    expect(call.model).toBe('litellm-responses/mini');
    expect(call.fallbackText).toBe('old text');
    expect(result.replacement).toBe('cleaned replacement');
  });

  it('honours an explicit model override', async () => {
    mockRunUtilityTextTask.mockResolvedValueOnce('x');
    const { runInlineEdit } = await import('./edit-engine.ts');

    await runInlineEdit({
      selection: 'a',
      beforeContext: '',
      afterContext: '',
      instruction: 'do something',
      model: 'claude-haiku-4-5-20251001',
    });
    expect(mockRunUtilityTextTask.mock.calls[0][0].model).toBe('claude-haiku-4-5-20251001');
  });

  it('routes selectionKind="html" to the HTML system prompt', async () => {
    mockRunUtilityTextTask.mockResolvedValueOnce('<p>ok</p>');
    const { runInlineEdit } = await import('./edit-engine.ts');

    await runInlineEdit({
      selection: '<p>old</p>',
      beforeContext: '',
      afterContext: '',
      instruction: 'rephrase',
      selectionKind: 'html',
    });
    const call = mockRunUtilityTextTask.mock.calls[0][0];
    // Tag-balance language is unique to the HTML prompt — load-bearing tell.
    expect(call.systemPrompt).toMatch(/[Tt]ag balance/);
    expect(call.systemPrompt).not.toMatch(/inline text editor\.\nScope/i);
  });

  it('defaults to the text system prompt when selectionKind is omitted', async () => {
    mockRunUtilityTextTask.mockResolvedValueOnce('ok');
    const { runInlineEdit } = await import('./edit-engine.ts');

    await runInlineEdit({
      selection: 'old',
      beforeContext: '',
      afterContext: '',
      instruction: 'do',
    });
    const call = mockRunUtilityTextTask.mock.calls[0][0];
    // Text prompt does NOT carry the HTML-specific tag-balance clause.
    expect(call.systemPrompt).not.toMatch(/[Tt]ag balance/);
    expect(call.systemPrompt).toMatch(/inline text editor/);
  });

  it('routes selectionKind=html + editMode=insertBefore to the inserter prompt', async () => {
    mockRunUtilityTextTask.mockResolvedValueOnce('<button>x</button>');
    const { runInlineEdit } = await import('./edit-engine.ts');

    await runInlineEdit({
      selection: '<p>anchor</p>',
      beforeContext: '',
      afterContext: '',
      instruction: 'add a button',
      selectionKind: 'html',
      editMode: 'insertBefore',
    });
    const call = mockRunUtilityTextTask.mock.calls[0][0];
    expect(call.systemPrompt).toMatch(/inline HTML inserter/);
    // Inserter prompt explicitly forbids reproducing SELECTION (key invariant).
    expect(call.systemPrompt).toMatch(/NOT replacing/);
    // Replace-mode HTML prompt does NOT have the inserter language.
    expect(call.systemPrompt).not.toMatch(/inline HTML editor\b/);
    // The user prompt should carry the EDIT_MODE block.
    expect(call.prompt).toContain('<<<EDIT_MODE>>>');
    expect(call.prompt).toMatch(/insertBefore/);
  });

  it('uses the regular HTML prompt when editMode=replace (default)', async () => {
    mockRunUtilityTextTask.mockResolvedValueOnce('<p>new</p>');
    const { runInlineEdit } = await import('./edit-engine.ts');

    await runInlineEdit({
      selection: '<p>old</p>',
      beforeContext: '',
      afterContext: '',
      instruction: 'rephrase',
      selectionKind: 'html',
      editMode: 'replace',
    });
    const call = mockRunUtilityTextTask.mock.calls[0][0];
    expect(call.systemPrompt).toMatch(/inline HTML editor\b/);
    expect(call.systemPrompt).not.toMatch(/inline HTML inserter/);
    // No EDIT_MODE block when replace (the default).
    expect(call.prompt).not.toContain('<<<EDIT_MODE>>>');
  });

  it('text mode ignores editMode (insertion is HTML-only)', async () => {
    mockRunUtilityTextTask.mockResolvedValueOnce('ok');
    const { runInlineEdit } = await import('./edit-engine.ts');

    await runInlineEdit({
      selection: 'old',
      beforeContext: '',
      afterContext: '',
      instruction: 'do',
      selectionKind: 'text',
      editMode: 'insertBefore',
    });
    const call = mockRunUtilityTextTask.mock.calls[0][0];
    // Markdown/txt insertions don't have a clean anchor model — fall back
    // to the text editor prompt regardless of editMode.
    expect(call.systemPrompt).toMatch(/inline text editor/);
  });

  it('insert-mode fallback returns empty string instead of original selection', async () => {
    // Network failure / engine-disabled fallback. For replace mode we return
    // the selection (no-change diff). For insertion modes the equivalent of
    // "do nothing" is empty output — otherwise we'd re-insert the anchor.
    mockRunUtilityTextTask.mockImplementationOnce(async (opts: any) => opts.fallbackText);
    const { runInlineEdit } = await import('./edit-engine.ts');

    const result = await runInlineEdit({
      selection: '<p>anchor</p>',
      beforeContext: '',
      afterContext: '',
      instruction: 'add divider',
      selectionKind: 'html',
      editMode: 'insertAfter',
    });
    expect(result.replacement).toBe('');
  });

  describe('SYSTEM_PROMPT_HTML_INSERT', () => {
    it('declares isolation', () => {
      expect(SYSTEM_PROMPT_HTML_INSERT).toMatch(/NO access to project files/);
    });
    it('forbids reproducing SELECTION in output', () => {
      // Load-bearing invariant: insert mode must NOT echo the anchor.
      expect(SYSTEM_PROMPT_HTML_INSERT).toMatch(/Do NOT include SELECTION/);
    });
    it('mandates tag balance', () => {
      expect(SYSTEM_PROMPT_HTML_INSERT).toMatch(/[Tt]ag balance/);
    });
    it('outputs empty string on ambiguity (vs unchanged selection in replace mode)', () => {
      expect(SYSTEM_PROMPT_HTML_INSERT).toMatch(/output an empty string/);
    });
  });

  it('throws on empty selection', async () => {
    const { runInlineEdit } = await import('./edit-engine.ts');
    await expect(
      runInlineEdit({ selection: '', beforeContext: '', afterContext: '', instruction: 'x' }),
    ).rejects.toThrow(/selection is empty/);
  });

  it('throws on whitespace-only selection', async () => {
    const { runInlineEdit } = await import('./edit-engine.ts');
    await expect(
      runInlineEdit({ selection: '   \n   ', beforeContext: '', afterContext: '', instruction: 'x' }),
    ).rejects.toThrow(/selection is empty/);
  });

  it('throws on empty instruction', async () => {
    const { runInlineEdit } = await import('./edit-engine.ts');
    await expect(
      runInlineEdit({ selection: 'a', beforeContext: '', afterContext: '', instruction: '   ' }),
    ).rejects.toThrow(/instruction is empty/);
  });

  it('throws when selection exceeds the size limit', async () => {
    const { runInlineEdit, LIMITS } = await import('./edit-engine.ts');
    const oversized = 'a'.repeat(LIMITS.maxSelectionChars + 1);
    await expect(
      runInlineEdit({ selection: oversized, beforeContext: '', afterContext: '', instruction: 'x' }),
    ).rejects.toThrow(/selection too long/);
  });

  it('throws when instruction exceeds the size limit', async () => {
    const { runInlineEdit, LIMITS } = await import('./edit-engine.ts');
    const oversized = 'x'.repeat(LIMITS.maxInstructionChars + 1);
    await expect(
      runInlineEdit({ selection: 'a', beforeContext: '', afterContext: '', instruction: oversized }),
    ).rejects.toThrow(/instruction too long/);
  });

  it('truncates oversized contexts before sending', async () => {
    mockRunUtilityTextTask.mockResolvedValueOnce('ok');
    const { runInlineEdit, LIMITS } = await import('./edit-engine.ts');
    const huge = 'B'.repeat(LIMITS.maxContextChars * 2);
    await runInlineEdit({
      selection: 'sel',
      beforeContext: huge,
      afterContext: huge,
      instruction: 'do',
    });
    const sent = mockRunUtilityTextTask.mock.calls[0][0].prompt as string;
    // Should not contain the full doubled-up before/after — only the trailing /
    // leading slice up to maxContextChars.
    const beforeBlock = sent.split('<<<SELECTION>>>')[0];
    const afterBlock = sent.split('<<<AFTER_CONTEXT>>>')[1].split('<<<INSTRUCTION>>>')[0];
    expect(beforeBlock.length).toBeLessThan(LIMITS.maxContextChars + 200);
    expect(afterBlock.length).toBeLessThan(LIMITS.maxContextChars + 200);
  });

  it('sanitizes a fenced response down to plain text', async () => {
    mockRunUtilityTextTask.mockResolvedValueOnce('```\nthe real text\n```');
    const { runInlineEdit } = await import('./edit-engine.ts');
    const result = await runInlineEdit({
      selection: 'sel',
      beforeContext: '',
      afterContext: '',
      instruction: 'do',
    });
    expect(result.replacement).toBe('the real text');
    expect(result.raw).toBe('```\nthe real text\n```');
  });
});
