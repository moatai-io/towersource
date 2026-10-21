import { describe, it, expect } from 'vitest';
import { installPiAfterToolCallHook } from './after-tool-call.js';
import { createPiVisualContextTransform } from './visual-context-lifecycle.js';

describe('native SDK afterToolCall preservation', () => {
  it('runs SDK normalization after Tower overrides and preserves metadata', async () => {
    const events: string[] = [];
    const agent: any = { afterToolCall: async (ctx: any) => {
      events.push('sdk');
      expect(ctx.result.content[0].data).toBe('tower-image');
      expect(ctx.isError).toBe(false);
      return {content:[{type:'image',data:'normalized',mimeType:'image/png'}], details:undefined};
    }};
    installPiAfterToolCallHook(agent, async () => {
      events.push('tower');
      return {content:[{type:'image',data:'tower-image',mimeType:'image/png'}],details:{provenance:true},isError:false};
    });
    const result = await agent.afterToolCall({result:{content:[],details:{}},isError:true});
    expect(events).toEqual(['tower','sdk']);
    expect(result.details).toEqual({provenance:true});
    expect(result.isError).toBe(false);
    expect(result.content[0].data).toBe('normalized');
    const history = ['a','b','c'].map(id=>({role:'toolResult',toolCallId:id,content:result.content}));
    expect(await createPiVisualContextTransform()(history)).toEqual(history);
  });
  it('retains the native result when Tower has no override', async () => {
    const agent: any = {afterToolCall:async()=>({content:[{type:'text',text:'native'}]})};
    installPiAfterToolCallHook(agent,async()=>undefined);
    expect((await agent.afterToolCall({result:{content:[]},isError:false})).content[0].text).toBe('native');
  });
  it('propagates native hook failures instead of accepting unprocessed images', async () => {
    const agent: any = {afterToolCall:async()=>{throw new Error('normalize failed');}};
    installPiAfterToolCallHook(agent,async()=>undefined);
    await expect(agent.afterToolCall({result:{content:[]},isError:false})).rejects.toThrow('normalize failed');
  });
});
