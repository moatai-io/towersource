import {describe,it,expect} from 'vitest';
import {datasetHealth,publicationsForAgent,type DatasetRefreshState,type ManagedPublication} from './managed-publication';
const now=Date.parse('2026-01-02T00:00:00Z');
const base:DatasetRefreshState={sourceAsOf:'2026-01-01T23:59:00Z',lastSuccessAt:'2026-01-02T00:00:00Z',lastAttempt:'succeeded',staleAfterMs:120000};
describe('publication management contract',()=>{
 it('reports a validated recent refresh',()=>expect(datasetHealth(base,now)).toBe('fresh'));
 it('does not confuse recent execution with recent source data',()=>expect(datasetHealth({...base,sourceAsOf:'2025-01-01T00:00:00Z'},now)).toBe('stale'));
 it('preserves failure even when last good data is recent',()=>expect(datasetHealth({...base,lastAttempt:'failed'},now)).toBe('failed'));
 it('reports refreshing separately',()=>expect(datasetHealth({...base,lastAttempt:'running'},now)).toBe('refreshing'));
 it.each([null,'invalid','2027-01-01T00:00:00Z'])('does not invent freshness for %s',sourceAsOf=>expect(datasetHealth({...base,sourceAsOf},now)).toBe('unknown'));
 it('filters stable Project identity, not folder display label',()=>{const items=[{id:'a',ownerProjectId:'p1'},{id:'b',ownerProjectId:'p2'}] as ManagedPublication[];expect(publicationsForAgent(items,'p1').map(p=>p.id)).toEqual(['a']);expect(items).toHaveLength(2)});
});
