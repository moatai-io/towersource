import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync('packages/backend/services/agent-workers.ts','utf8');
describe('worker pause survives asynchronous completion',()=>{
 it('fences ordinary status updates against paused and archived rows',()=>{
 expect(source).toContain("AND (status NOT IN ('paused', 'archived') OR $2 IN ('paused', 'archived'))");
 });
 it('requires an explicit paused-state transition to resume',()=>{
 expect(source).toContain("UPDATE agent_workers SET status='idle',updated_at=NOW() WHERE id=$1 AND status='paused'");
 });
});
