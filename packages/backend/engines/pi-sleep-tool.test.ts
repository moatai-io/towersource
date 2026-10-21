import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/agent-sleep/alarms.js', () => ({MAX_WAIT_SECONDS:2592000, WAIT_DESCRIPTION:'Saved wait',scheduleWait:vi.fn(async()=>({ok:true,status:'scheduled'}))}));
import { createSleepTool } from './pi-sleep-tool.js';
import { scheduleWait } from '../services/agent-sleep/alarms.js';
describe('Pi wait tool',()=>{
 it('saves a day-long alarm without holding a timer',async()=>{
 const tool=createSleepTool({sessionId:'s',rootTurnId:'root'});
 expect(tool.name).toBe('wait');expect(tool.executionMode).toBe('sequential'); expect(tool.parameters.properties.durationSeconds.maximum).toBe(2592000);
 const result=await tool.execute('call',{durationSeconds:86400,reason:'check'},undefined);
 expect(scheduleWait).toHaveBeenCalledWith({durationSeconds:86400,reason:'check'},{sessionId:'s',rootTurnId:'root'});
 expect(JSON.parse(result.content[0].text)).toMatchObject({status:'scheduled'});
 });
});
