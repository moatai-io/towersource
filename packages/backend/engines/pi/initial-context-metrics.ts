import { estimateProviderInput } from './provider-request-budget.js';
// Secret-free, approximate sizing of the first outgoing Responses request.
// Never retain or log request content, tool names, argument values, or URLs.
const measuredSessions = new Set<string>();

function size(value: unknown): { bytes: number; estimatedTokens: number } {
  if (value === undefined) return { bytes: 0, estimatedTokens: 0 };
  const text = JSON.stringify(value);
  return { bytes: Buffer.byteLength(text, 'utf8'), estimatedTokens: estimateProviderInput(value).estimatedTokens };
}

export function measureInitialResponsesContext(body: any, sessionId: string | undefined): Record<string, unknown> | null {
  if (!sessionId || measuredSessions.has(sessionId)) return null;
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const input = Array.isArray(body?.input) ? body.input : [];
  // Do not classify instructions heuristically: the SDK combines Tower, Pi,
  // AGENTS.md and skill metadata into one opaque instructions string.
  const toolSizes: Array<{ bytes: number; estimatedTokens: number }> = tools.map(size);
  const total = (sizes: Array<{ bytes: number; estimatedTokens: number }>) => ({
    bytes: sizes.reduce((sum, item) => sum + item.bytes, 0),
    estimatedTokens: sizes.reduce((sum, item) => sum + item.estimatedTokens, 0),
  });
  measuredSessions.add(sessionId);
  return {
    kind: 'initial-responses-context',
    instructions: size(body?.instructions),
    input: size(input),
    tools: { count: tools.length, ...total(toolSizes) },
    toolSizeBuckets: {
      under1KiB: toolSizes.filter(item => item.bytes < 1024).length,
      from1To4KiB: toolSizes.filter(item => item.bytes >= 1024 && item.bytes < 4096).length,
      over4KiB: toolSizes.filter(item => item.bytes >= 4096).length,
    },
    // This is the outgoing JSON body, not provider-billed input tokens.
    request: size(body),
  };
}
