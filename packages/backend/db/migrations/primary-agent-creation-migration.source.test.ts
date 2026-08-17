import fs from 'node:fs';import path from 'node:path';import{describe,expect,it}from'vitest';
const commands=fs.readFileSync(path.join(process.cwd(),'packages/backend/db/migrations/124_primary_agent_creation_commands.sql'),'utf8');
const bindings=fs.readFileSync(path.join(process.cwd(),'packages/backend/db/migrations/125_agent_harness_binding_revisions.sql'),'utf8');
describe('Primary Agent creation and binding revisions migrations',()=>{
it('tracks idempotent command resources and states',()=>{expect(commands).toContain('primary_agent_creation_commands');expect(commands).toContain('UNIQUE(actor_user_id,idempotency_key)');expect(commands).toContain('agent_creation_command_id');expect(commands).toContain('primary_agent_creation_events')});
it('keeps append-only binding revisions and rollback provenance',()=>{expect(bindings).toContain('agent_harness_binding_revisions');expect(bindings).toContain('previous_revision');expect(bindings).toContain('current_revision');expect(bindings).toContain('idx_agent_harness_one_active_revision')});
});
