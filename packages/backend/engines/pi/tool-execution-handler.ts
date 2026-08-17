// Owns pure extraction from Pi tool_execution_end events.
// Public API: handlePiToolExecutionEnd.

export interface PiToolExecutionEndResult {
  toolCallId?: string;
  resultText: string;
  editedFile?: { filePath: string; toolName: string };
}

export function handlePiToolExecutionEnd(event: any): PiToolExecutionEndResult {
  const resultContent = event.result?.content;
  const displayResult = event.result?.details?.displayResult;
  const resultText = typeof displayResult === 'string'
    ? displayResult
    : Array.isArray(resultContent)
      ? resultContent.map((c: any) => c.text || '').join('\n')
      : JSON.stringify(event.result);

  const toolName = String(event.toolName || '').toLowerCase();
  const filePath = event.args?.path || event.args?.file_path;
  const editedFile = (toolName === 'write' || toolName === 'edit') && filePath
    ? { filePath, toolName: event.toolName || toolName }
    : undefined;

  return {
    toolCallId: event.toolCallId,
    resultText,
    editedFile,
  };
}
