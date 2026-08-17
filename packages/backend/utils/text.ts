/**
 * Extract plain text from message content.
 * Content can be a plain string or a JSON array of content blocks like [{type:"text", text:"..."}].
 */
export function extractTextFromContent(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((b: any) => b.type === 'text' || b.type === 'artifact_markdown' || b.type === 'agent_run')
        .map((b: any) => {
          if (b.type === 'agent_run') return [b.workerName, b.summary].filter(Boolean).join(' ');
          return b.text;
        })
        .join(' ');
    }
    return content;
  } catch {
    return content;
  }
}
