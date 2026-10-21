import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PdfObservationState } from './pdf-observation-state.js';

export function createPdfObservationTool(state: PdfObservationState): ToolDefinition {
  return {
    name: 'pdf_observe', label: 'PDF observation',
    description: 'After viewing PDF pages, record findings and uncertainties. No text tags or copied batch IDs are needed when one batch is pending. For ambiguous batches use the batchId returned in pendingBatches. Records are model observations, not proof of accuracy.',
    parameters: Type.Object({ findings: Type.String({ minLength: 1, maxLength: 3000 }), uncertainties: Type.String({ maxLength: 800 }), batchId: Type.Optional(Type.String()) }),
    async execute(_id: string, args: any) {
      const receipt = state.recordObservation(args.findings, args.uncertainties, args.batchId);
      return { content: [{ type: 'text', text: JSON.stringify(receipt) }], details: receipt, isError: !receipt.ok };
    },
  } as ToolDefinition;
}
