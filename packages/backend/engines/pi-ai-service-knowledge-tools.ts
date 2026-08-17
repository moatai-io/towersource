/** Owns: Pi tools that expose only immutable AI Service Deployment Knowledge snapshots. */
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { readSnapshotKnowledge, searchSnapshotKnowledge } from '../services/ai-service/snapshot-knowledge.js';

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], details: value };
}

/** Create snapshot-only search/read tools. The captured value contains document content, not paths to read. */
export function createAIServiceKnowledgeTools(sourceSnapshot: unknown): ToolDefinition[] {
  return [
    {
      name: 'knowledge_search',
      label: 'Search deployment knowledge',
      description: 'Search only the immutable Knowledge documents approved in this AI Service Deployment. Returns document IDs, snippets, line ranges, and citations.',
      parameters: Type.Object({
        query: Type.String({ description: 'Natural-language or keyword query' }),
        scope: Type.Optional(Type.String({ description: 'Optional snapshot path prefix such as knowledge/policies' })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      }),
      execute: async (_toolCallId, input) => textResult(searchSnapshotKnowledge(sourceSnapshot, input as { query: string; scope?: string; limit?: number })),
    },
    {
      name: 'knowledge_read',
      label: 'Read deployment knowledge',
      description: 'Read a bounded line range from one document returned by knowledge_search. Accepts only an opaque snapshot documentId, never a filesystem path.',
      parameters: Type.Object({
        documentId: Type.String({ description: 'Opaque document ID returned by knowledge_search' }),
        lineStart: Type.Optional(Type.Integer({ minimum: 1 })),
        lineEnd: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      execute: async (_toolCallId, input) => textResult(readSnapshotKnowledge(sourceSnapshot, input as { documentId: string; lineStart?: number; lineEnd?: number })),
    },
  ];
}
