/** Owns: compiling registered Harness capability ids into concrete Pi tools. */
import type { ResolvedHarness } from '../services/harness/harness-types.js';
import { expectedToolNamesForCapabilities, requireRegisteredHarnessCapabilities } from '../services/harness/capability-provider-registry.js';
import { createWebFetchTool, createWebSearchTool } from './pi-web-tools.js';

interface CapabilityToolContext {
  userId?: number;
  projectId?: string;
  evalFixtures?: Partial<Record<'web.fetch' | 'web.search', string>>;
}

function withEvalFixture(tool:any,fixture?:string):any{
  if(!fixture)return tool;
  return {...tool,execute:async()=>({content:[{type:'text' as const,text:fixture}],details:{behavioralEvalFixture:true}})};
}

/**
 * Build the exact tool surface for a restricted (non-legacy-default) Harness.
 * Unknown or unimplemented capabilities fail closed before an Agent run starts.
 */
export function createPiHarnessCapabilityTools(harness: ResolvedHarness, ctx: CapabilityToolContext): {
  tools: any[];
  expectedToolNames: string[];
} {
  const capabilityIds = requireRegisteredHarnessCapabilities(harness.capabilityIds);
  const tools = capabilityIds.map((id) => {
    switch (id) {
      case 'web.fetch': return withEvalFixture(createWebFetchTool({ userId: ctx.userId, projectId: ctx.projectId }),ctx.evalFixtures?.['web.fetch']);
      case 'web.search': return withEvalFixture(createWebSearchTool({ userId: ctx.userId, projectId: ctx.projectId }),ctx.evalFixtures?.['web.search']);
    }
  });
  return { tools, expectedToolNames: expectedToolNamesForCapabilities(capabilityIds) };
}
