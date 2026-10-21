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
  const isMarkdownWrite = ['create_markdown_artifact', 'update_markdown_artifact'].includes(toolName);
  let filePath = event.args?.path || event.args?.file_path;
  let succeeded = !event.isError && !event.result?.isError;
  if (isMarkdownWrite) {
    // Markdown receipts own the canonical persisted path. Input paths may be relative.
    let receipt: any;
    try { receipt = JSON.parse(resultText); } catch { /* No receipt means no verified save. */ }
    succeeded = succeeded && receipt?.ok === true && receipt?.artifact === 'markdown';
    filePath = receipt?.path;
  }
  const editedFile = succeeded && (toolName === 'write' || toolName === 'edit' || isMarkdownWrite)
    && typeof filePath === 'string' && filePath.length > 0
    ? { filePath, toolName: event.toolName || toolName }
    : undefined;

  return {
    toolCallId: event.toolCallId,
    resultText,
    editedFile,
  };
}
