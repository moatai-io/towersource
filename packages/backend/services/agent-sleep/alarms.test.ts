import { describe,expect,it,vi } from 'vitest';
vi.mock('../../db/pg-repo.js',()=>({query:vi.fn(),queryOne:vi.fn(),transaction:vi.fn()}));
import { validateWait,validateWakeAt,MAX_WAIT_SECONDS,alarmDto } from './alarms.js';
import { decideTurnTerminal } from '../agent-turn/turn-terminal.js';
describe('durable wait contract',()=>{
 it('bounds waits at 30 days and accepts a full day',()=>{expect(validateWait({durationSeconds:86400,reason:' next check '})).toEqual({durationSeconds:86400,reason:'next check'});expect(validateWait({durationSeconds:MAX_WAIT_SECONDS,reason:'check'})).toBeTruthy();for(const seconds of [0,1.5,MAX_WAIT_SECONDS+1,NaN])expect(()=>validateWait({durationSeconds:seconds,reason:'check'})).toThrow();});
 it('validates reschedule against a future bounded time',()=>{const now=Date.parse('2030-01-01T00:00:00Z');expect(validateWakeAt('2030-01-02T00:00:00Z',now)).toBe('2030-01-02T00:00:00.000Z');for(const value of ['bad','2030-01-01T00:00:00Z','2030-02-01T00:00:00Z'])expect(()=>validateWakeAt(value,now)).toThrow();});
 it('projects dates to a reload-safe DTO',()=>{expect(alarmDto({id:'a',session_id:'s',status:'pending',wake_at:new Date('2030-01-01'),reason:'check',version:1,created_at:new Date('2029-01-01'),updated_at:new Date('2029-01-01')} as any)).toMatchObject({sessionId:'s',wakeAt:'2030-01-01T00:00:00.000Z',version:1});});
 it('normal wait completion is not an aborted or empty-answer retry',()=>{expect(decideTurnTerminal({sessionId:'s',rootTurnId:'r',engineOutcome:'wait_requested'})).toMatchObject({outcome:'completed',reason:'durable_wait_scheduled'});expect(decideTurnTerminal({sessionId:'s',rootTurnId:'r',engineOutcome:'wait_requested',stopMode:'force'}).outcome).toBe('stopped');});
});
