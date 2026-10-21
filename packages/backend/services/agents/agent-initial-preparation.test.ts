import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareInitialAgent, buildInitialPreparationContext, scheduleInitialPreparation, type PreparationInput } from './agent-initial-preparation.js';
const roots: string[] = [];
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-preparation-')); roots.push(dir); return dir; }
const input: PreparationInput = { projectId:'agent',profileVersion:1,commandId:'command',approvedCardHash:'hash',name:'팀원',role:'기획 검토',promise:'근거 있는 대안',instruction:'외부 발송 금지',firstMission:'제안 검토' };
afterEach(() => roots.splice(0).forEach(dir => fs.rmSync(dir,{recursive:true,force:true})));
describe('creation-only bounded preparation', () => {
 it('preserves expectations in another session and prioritizes supplied work over onboarding', () => {
  const dir=root(); expect(prepareInitialAgent(dir,input)).toBe('ready');
  const context=buildInitialPreparationContext(dir,'agent',1);
  expect(context).toContain('제안 검토'); expect(context).toContain('가장 중요한 질문 하나');
  expect(context).toContain('정보가 충분하면 재질문 없이'); expect(context).toContain('낡은 질문 후보를 버리고');
  expect(fs.readdirSync(dir).sort()).toEqual(['.tower-initial-preparation.json','.tower-interview.json','character.md']);
 });
 it('uses role-specific inputs without inventing qualifications or authority', () => {
  const a=root(),b=root(); prepareInitialAgent(a,input);prepareInitialAgent(b,{...input,role:'코드 오류 복구',firstMission:'테스트 검증'});
  expect(buildInitialPreparationContext(a,'agent',1)).not.toEqual(buildInitialPreparationContext(b,'agent',1));
  expect(fs.readFileSync(path.join(a,'character.md'),'utf8')).toContain('추정하지 않았습니다');
 });
 it('does not repeat initialization or overwrite user changes', () => {
  const dir=root(); prepareInitialAgent(dir,input);const state=fs.readFileSync(path.join(dir,'.tower-initial-preparation.json'),'utf8');
  fs.writeFileSync(path.join(dir,'character.md'),'사용자 수정');expect(prepareInitialAgent(dir,input)).toBe('preserved');
  expect(fs.readFileSync(path.join(dir,'character.md'),'utf8')).toBe('사용자 수정');
  expect(fs.readFileSync(path.join(dir,'.tower-initial-preparation.json'),'utf8')).toBe(state);
  expect(buildInitialPreparationContext(dir,'agent',1)).toBe('');
 });
 it('rejects stale profile results and foreign project results', () => {
  const dir=root();prepareInitialAgent(dir,input);expect(buildInitialPreparationContext(dir,'agent',2)).toBe('');expect(buildInitialPreparationContext(dir,'other',1)).toBe('');
 });
 it('preserves existing SOUL and character sources', () => {
  const dir=root();fs.writeFileSync(path.join(dir,'SOUL.md'),'기존 정본');prepareInitialAgent(dir,input);
  expect(fs.existsSync(path.join(dir,'character.md'))).toBe(false);
  expect(buildInitialPreparationContext(dir,'agent',1)).toContain('기존 SOUL.md');
 });
 it('failure does not prevent use and invalid/oversized state loads nothing', async () => {
  const dir=root();const missing=path.join(dir,'missing');expect(prepareInitialAgent(missing,input)).toBe('failed');
  expect(() => scheduleInitialPreparation(missing,input)).not.toThrow();await Promise.resolve();
  fs.writeFileSync(path.join(dir,'.tower-initial-preparation.json'),'x'.repeat(33000));expect(buildInitialPreparationContext(dir,'agent',1)).toBe('');
 });
 it('has no connector, model, installer or question tool imports', () => {
  const source=fs.readFileSync(new URL('./agent-initial-preparation.ts',import.meta.url),'utf8');
  expect(source).not.toMatch(/import .*?(credential|connector|engine|spawn|child_process|AskUserQuestion)/i);
 });
});

describe('production wiring', () => {
 it('schedules preparation only after creation is ready and loads it in the shared session prompt', () => {
  const creation=fs.readFileSync(new URL('./primary-agent-creation.ts',import.meta.url),'utf8');
  expect(creation.indexOf('scheduleInitialPreparation(project.rootPath!')).toBeGreaterThan(creation.indexOf("await event(command.id,'command_ready'"));
  const prompt=fs.readFileSync(new URL('../system-prompt.ts',import.meta.url),'utf8');
  expect(prompt).toContain('buildInitialPreparationContext(user.sessionProjectRoot, user.projectId, profile?.profileVersion ?? 0)');
 });
});

describe('observable preparation', () => {
 it('records start/end and prevents duplicate scheduling', async () => {
  const {runInitialPreparation}=await import('./agent-initial-preparation.js');
  const dir=root(), phases:string[]=[];
  const prepared={...input,projectId:'observable',sessionId:'session'};
  const observer={event:async (phase:string)=>{phases.push(phase);}};
  await Promise.all([runInitialPreparation(dir,prepared,observer),runInitialPreparation(dir,prepared,observer)]);
  expect(phases).toEqual(['started','completed']);
 });
 it('records failure without blocking callers', async () => {
  const {runInitialPreparation}=await import('./agent-initial-preparation.js');
  const phases:string[]=[];
  await runInitialPreparation(path.join(root(),'missing'),{...input,projectId:'failure'}, {event:async phase=>{phases.push(phase);}});
  expect(phases).toEqual(['started','failed']);
 });
 it('prefers the explicit session root over cwd discovery', () => {
  const source=fs.readFileSync(new URL('../../engines/pi/session-resources.ts',import.meta.url),'utf8');
  expect(source).toContain('opts.sessionProjectRoot ?? resolveSessionProjectRoot(opts.cwd)');
 });
});
