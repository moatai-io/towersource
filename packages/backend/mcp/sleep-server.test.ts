import { describe, expect, it, vi } from 'vitest';
vi.mock('@anthropic-ai/claude-agent-sdk',()=>({tool:(name:string,description:string,schema:unknown,execute:unknown)=>({name,description,schema,execute}),createSdkMcpServer:(config:unknown)=>config}));
vi.mock('../services/agent-sleep/alarms.js',()=>({MAX_WAIT_SECONDS:2592000,WAIT_DESCRIPTION:'stored wait'}));
import { createSleepMcpServer } from './sleep-server.js';
describe('Claude wait safe limitation',()=>{
 it('rejects unsupported parking explicitly before writing an alarm',async()=>{
  const server=createSleepMcpServer({sessionId:'s'}) as any;expect(server.name).toBe('wait');
  const tool=server.tools[0];expect(tool.schema.durationSeconds.safeParse(86400).success).toBe(true);expect(tool.schema.durationSeconds.safeParse(2592001).success).toBe(false);
  const result=await tool.execute({durationSeconds:86400,reason:'check'});expect(result.isError).toBe(true);expect(result.content[0].text).toContain('No alarm was created');
 });
});
