import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root=path.resolve(import.meta.dirname,'../..');
const spawn=fs.readFileSync(path.join(root,'services/session/spawn-rpc.ts'),'utf8');
const index=fs.readFileSync(path.join(root,'index.ts'),'utf8');

describe('durable Agent delivery recovery wiring',()=>{
 it('reconstructs only accepted agent_send requests with an existing root turn',()=>{
  expect(spawn).toContain('export async function recoverDurableSessionSend');
  expect(spawn).toContain("message.kind !== 'request' || message.body.sourceType !== 'agent_send'");
  expect(spawn).toContain('!message.sourceRootTurnId');
  expect(spawn).toContain('getAllRunningSessionIds().includes(message.recipientSessionId)');
 });
 it('runs the recovery through the same background Session runner and callback path',()=>{
  const recovery=spawn.slice(spawn.indexOf('export async function recoverDurableSessionSend'),spawn.indexOf('async function runSendInBackground'));
  expect(recovery).toContain('await runSendInBackground(');
  expect(recovery).toContain("message.deliveryPolicy === 'wake' ? 'wake'");
 });
 it('starts the pump only outside candidate passive mode and stops it on signals',()=>{
  expect(index).toMatch(/if \(!candidatePassiveMode\) \{[\s\S]*startDeliveryPump\(\{/);
  expect(index).toContain('deliver: async (message) => recoverDurableSessionSend(message)');
  expect(index.match(/stopDeliveryPump/g)?.length).toBeGreaterThanOrEqual(2);
 });
});
