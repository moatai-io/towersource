/**
 * Owns: Convert Tower in-process MCP servers (createSdkMcpServer) → Pi ToolDefinition[].
 * Public API: mcpServerToPiTools(servers).
 * See README in workspace/decisions/2026-05-16-pi-vs-claude-gap-catchup.md (W1).
 *
 * Bridges Claude Agent SDK's MCP tool surface (Zod RawShape inputSchema, MCP
 * CallToolResult.content[]) over to Pi SDK's tool surface (TypeBox parameters,
 * AgentToolResult.content[]). Tower's sandbox + tower-spawn MCP servers were
 * authored against the Claude SDK shape; this adapter reuses them verbatim
 * (no fork) so Pi sessions get the identical 7 sandbox + 6 spawn tools.
 *
 * Schema strategy:
 *   - MCP tool.inputSchema is a Zod RawShape (Record<string, ZodType>).
 *   - We wrap with z.object(...) and call z.toJSONSchema() (Zod v4) to get a
 *     JSON Schema object, then pass through Type.Unsafe() so the result is
 *     TSchema-shaped for Pi's TypeScript-facing API.
 *   - Pi's providers (anthropic/openai-completions/openai-responses) all
 *     forward `tool.parameters` as raw JSON Schema, so this works without
 *     further conversion.
 *
 * Result strategy:
 *   - MCP handler returns { content: Array<{type:'text', text:string}|{type:'image', data, mimeType}>, isError? }.
 *   - Pi expects AgentToolResult: { content: (TextContent|ImageContent)[], details }.
 *   - Shape is already compatible — just map content blocks 1:1 and stuff
 *     `isError` into a synthetic text block when set so the Pi UI surfaces it.
 *
 * Failure handling:
 *   - Per-tool conversion errors (missing schema, toJSONSchema throw) →
 *     console.warn + skip that tool. Never throw out of this function.
 *   - Handler errors at runtime → forwarded to Pi as {content:[{type:'text',text:'<error>'}]}.
 */

import { Type, type TSchema } from '@sinclair/typebox';
import { z, toJSONSchema } from 'zod';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

type AnyMcpServer = {
  instance?: {
    _registeredTools?: Record<string, {
      description?: string;
      inputSchema?: any;
      handler: (args: any, extra: any) => Promise<any>;
      enabled?: boolean;
      annotations?: any;
    }>;
    close?: () => Promise<void> | void;
  };
};

interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [k: string]: unknown;
}

/**
 * Convert a Zod RawShape (or full ZodObject) to a JSON Schema object suitable
 * for Pi's `parameters` field. Returns null on failure (caller logs+skips).
 */
function shapeToJsonSchema(inputSchema: any): Record<string, unknown> | null {
  if (!inputSchema || typeof inputSchema !== 'object') return null;
  try {
    // If already a Zod object schema (has _zod/_def), call toJSONSchema directly.
    const isZodSchema = inputSchema._zod !== undefined || inputSchema._def !== undefined;
    const zodObject = isZodSchema ? inputSchema : z.object(inputSchema);
    const json = toJSONSchema(zodObject as any) as Record<string, unknown>;
    return json;
  } catch (err) {
    console.warn('[pi-mcp-adapter] shapeToJsonSchema failed:', (err as Error)?.message);
    return null;
  }
}

/**
 * Map an MCP CallToolResult.content[] into Pi's AgentToolResult.content[].
 * Pi accepts TextContent ({type:'text',text}) and ImageContent ({type:'image',data,mimeType}).
 * Anything unknown is stringified into a text block so nothing is silently dropped.
 */
function mapContent(
  mcpContent: McpContentBlock[] | undefined,
  isError: boolean,
): Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> {
  const out: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
  if (Array.isArray(mcpContent)) {
    for (const block of mcpContent) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        out.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
        out.push({ type: 'image', data: block.data, mimeType: block.mimeType });
      } else {
        // Unknown block (resource link, audio, etc.) — stringify so the AI at
        // least sees that something came back.
        try {
          out.push({ type: 'text', text: JSON.stringify(block) });
        } catch {
          out.push({ type: 'text', text: `[unrenderable MCP content block: ${block.type}]` });
        }
      }
    }
  }
  if (out.length === 0) {
    out.push({ type: 'text', text: isError ? '[MCP tool returned error with no content]' : '[MCP tool returned no content]' });
  }
  return out;
}

/**
 * Iterate Tower's in-process MCP servers and emit one Pi ToolDefinition per
 * registered tool. Tool names are kept raw (`mcp__<server>__<tool>`) — the W3
 * pass will retire that prefix uniformly across both engines.
 *
 * Returns [] when servers is empty / has no instance / no registered tools.
 * Conversion errors are swallowed at the tool granularity; one bad tool does
 * not block the rest of the server from mounting.
 */
export function mcpServerToPiTools(servers: Record<string, AnyMcpServer>): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const [serverName, server] of Object.entries(servers || {})) {
    const reg = server?.instance?._registeredTools;
    if (!reg || typeof reg !== 'object') {
      console.warn(`[pi-mcp-adapter] server "${serverName}" exposes no _registeredTools — skip`);
      continue;
    }

    for (const [toolName, registered] of Object.entries(reg)) {
      if (!registered || typeof registered.handler !== 'function') {
        console.warn(`[pi-mcp-adapter] ${serverName}/${toolName} missing handler — skip`);
        continue;
      }
      if (registered.enabled === false) continue;

      const jsonSchema = shapeToJsonSchema(registered.inputSchema);
      if (!jsonSchema) {
        console.warn(`[pi-mcp-adapter] ${serverName}/${toolName} schema conversion failed — skip`);
        continue;
      }

      // Wrap raw JSON Schema as TypeBox-flavoured TSchema. Pi's providers
      // forward this as-is; the wrapper is purely for the TS-level contract.
      const parameters = Type.Unsafe<unknown>(jsonSchema) as TSchema;

      const fullName = `mcp__${serverName}__${toolName}`;
      const description = registered.description || `MCP tool ${fullName}`;

      const piTool: ToolDefinition = {
        name: fullName,
        label: fullName,
        description,
        parameters,
        async execute(
          toolCallId: string,
          params: any,
          signal: AbortSignal | undefined,
        ) {
          try {
            // Preserve Pi's stable tool call id for MCP tools that use it as an
            // idempotency key across continuation/recovery.
            const result = await registered.handler(params ?? {}, { signal, toolCallId });
            const isError = !!(result && (result as any).isError);
            return {
              content: mapContent((result as any)?.content, isError),
              details: undefined,
            };
          } catch (err) {
            const msg = (err as Error)?.message || String(err);
            return {
              content: [{ type: 'text' as const, text: `[MCP tool error] ${fullName}: ${msg}` }],
              details: undefined,
            };
          }
        },
      } as ToolDefinition;

      out.push(piTool);
    }
  }
  return out;
}
