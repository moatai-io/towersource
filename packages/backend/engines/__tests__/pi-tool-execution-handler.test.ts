import { describe, expect, it } from 'vitest';
import { handlePiToolExecutionEnd } from '../pi/tool-execution-handler.js';

describe('Pi tool_execution_end handler', () => {
  it('extracts text result content and tool call id', () => {
    expect(handlePiToolExecutionEnd({
      toolCallId: 'tool-1',
      result: { content: [{ text: 'hello' }, { text: 'world' }] },
      toolName: 'read',
    })).toEqual({
      toolCallId: 'tool-1',
      resultText: 'hello\nworld',
      editedFile: undefined,
    });
  });

  it('uses a structured display result when a tool provides one', () => {
    const displayResult = '{"kind":"tower.ask_user_question_result","status":"answered","answers":[]}';
    expect(handlePiToolExecutionEnd({
      toolCallId: 'tool-auq',
      result: {
        content: [{ text: 'Environment: Production' }],
        details: { displayResult },
      },
      toolName: 'AskUserQuestion',
    }).resultText).toBe(displayResult);
  });

  it('stringifies non-array result payloads', () => {
    expect(handlePiToolExecutionEnd({
      result: { ok: true },
      toolName: 'bash',
    }).resultText).toBe('{"ok":true}');
  });

  it('detects write/edit file edits from path or file_path', () => {
    expect(handlePiToolExecutionEnd({
      result: { content: [] },
      toolName: 'Write',
      args: { path: 'a.txt' },
    }).editedFile).toEqual({ filePath: 'a.txt', toolName: 'Write' });

    expect(handlePiToolExecutionEnd({
      result: { content: [] },
      toolName: 'edit',
      args: { file_path: 'b.txt' },
    }).editedFile).toEqual({ filePath: 'b.txt', toolName: 'edit' });
  });

  it('does not mark non-editing tools as edited files', () => {
    expect(handlePiToolExecutionEnd({
      result: { content: [] },
      toolName: 'read',
      args: { path: 'a.txt' },
    }).editedFile).toBeUndefined();
  });
});
