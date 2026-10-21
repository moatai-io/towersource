import type { ContentBlock } from '../stores/chat-store';

/** View-only projection. Never persist/reinject the derived body into model history. */
export function projectMarkdownArtifact(block: ContentBlock): ContentBlock {
  const tool = block.toolUse;
  if (block.type !== 'tool_use' || !tool || !['create_markdown_artifact', 'update_markdown_artifact'].includes(tool?.name || '') || typeof tool.input?.body !== 'string') return block;
  let receipt: any;
  try { receipt = JSON.parse(tool.result || '{}'); } catch { receipt = { ok: false, error: tool.result }; }
  return {
    type: 'artifact_markdown',
    text: receipt.presentation === 'viewer' ? undefined : tool.input.body,
    title: tool.input.title,
    operation: tool.name === 'update_markdown_artifact' ? 'update' : 'create',
    path: tool.input.path,
    portablePath: receipt.ok === true && receipt.artifact === 'markdown' ? receipt.path : undefined,
    status: !tool.result ? 'pending' : receipt.ok === true && receipt.artifact === 'markdown' ? 'saved' : 'error',
    // Raw stderr and machine codes belong to diagnostics, not document prose.
    error: receipt.ok === false && typeof receipt.userMessage === 'string' ? receipt.userMessage : undefined,
  };
}
