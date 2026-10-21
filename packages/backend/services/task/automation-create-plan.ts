/** Owns: fail-closed natural-language creation preview and exact draft activation.
 * Preview persists a disabled Automation; only the reviewed configuration hash
 * can be activated. No model inference, Task dispatch or schema migration here.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { transaction } from '../../db/pg-repo.js';
import { getProject } from '../pm/project-manager.js';
import { canAccessSession } from '../pm/project-access.js';
import { getSession } from '../session/session-manager.js';
import { isSelectablePiModelId } from '../../config.js';
import { persistPiSessionChoice } from '../model-policy/session-alias.js';
import { createAutomation, getAutomationForUpdateInTransaction, activateCreationPlanInTransaction, type Automation } from './automation-manager.js';
import { authorizeAutomationMutation } from './automation-mutation-policy.js';
import { canAccessAutomationJob } from './schedule-permissions.js';
import { calculateZonedNextRun, validateScheduleTimezone } from './schedule-clock.js';
import { resolveAutomationModel } from './automation-model.js';
import { inspectAutomationCreationReadiness } from './automation-creation-readiness.js';

const cronSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('daily'), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }).strict(),
  z.object({ type: z.literal('weekdays'), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }).strict(),
  z.object({ type: z.literal('weekly'), day: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }).strict(),
  z.object({ type: z.literal('interval'), minutes: z.number().int().min(1).max(10080) }).strict(),
]);
const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }).strict(),
  z.object({ type: z.literal('cron'), config: cronSchema }).strict(),
  z.object({ type: z.literal('once'), at: z.string().datetime({ offset: true }) }).strict(),
]);
export const createPlanInputSchema = z.object({
  request: z.string().trim().min(1).max(8000), projectId: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(120).optional(), timezone: z.string().min(1).max(80).default('Asia/Seoul'),
  modelMode: z.enum(['core', 'session']).default('core'), sourceSessionId: z.string().min(1).max(100).optional(),
  trigger: triggerSchema.optional(),
}).strict();
export class AutomationPlanError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export interface AutomationPlanActor { userId: number; role?: string | null }
export type PlanTrigger = z.infer<typeof triggerSchema>;

/** Bounded compiler: unclear timing is a question, never an invented interval. */
export function compileCreationTrigger(request: string): PlanTrigger | null {
  const times = [...request.matchAll(/(?:오전|오후)?\s*(\d{1,2})\s*시(?!간)(?:\s*(\d{1,2})\s*분)?|\b(\d{1,2}):(\d{2})\b/g)];
  const intervals = [...request.matchAll(/(\d+)\s*(분|시간)마다|every\s+(\d+)\s+(minutes?|hours?)/gi)];
  if (times.length > 1 || intervals.length > 1 || (times.length > 0 && intervals.length > 0)) return null;
  const matched = times[0];
  const time = matched ? [matched[0], matched[1] || matched[3], matched[2] || matched[4]] : null;
  let hour = time ? Number(time[1]) : NaN;
  const minute = time ? Number(time[2] || 0) : 0;
  if (/오후/.test(time?.[0] || '') && hour < 12) hour += 12;
  if (/오전/.test(time?.[0] || '') && hour === 12) hour = 0;
  if (time && (hour > 23 || minute > 59)) return null;
  if (/수동|필요할 때|manual|on demand/i.test(request)) {
    return time || intervals.length || /매일|매주|평일|daily|weekly|every/i.test(request) ? null : { type: 'manual' };
  }
  const interval = request.match(/(\d+)\s*(분|시간)마다/) || request.match(/every\s+(\d+)\s+(minutes?|hours?)/i);
  if (interval && /매일|평일|매주|daily|weekly|weekdays|수동|manual/i.test(request)) return null;
  if (interval && !time) {
    const minutes = Number(interval[1]) * (/시간|hour/i.test(interval[2]) ? 60 : 1);
    return minutes >= 1 && minutes <= 10080 ? { type: 'cron', config: { type: 'interval', minutes } } : null;
  }
  if (!time) return null;
  // Conflicting patterns require clarification rather than choosing a schedule.
  const patterns = [/매일|daily/i.test(request), /평일|weekdays/i.test(request), /매주|weekly/i.test(request)];
  if (patterns.filter(Boolean).length !== 1) return null;
  if (patterns[0]) return { type: 'cron', config: { type: 'daily', hour, minute } };
  if (patterns[1]) return { type: 'cron', config: { type: 'weekdays', hour, minute } };
  // The supported weekly trigger has exactly one day. Never discard extra days.
  const days = [...request.matchAll(/매주\s*([일월화수목금토])(?:요일)?|([일월화수목금토])요일|\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi)];
  if (days.length !== 1) return null;
  const koreanDay = days[0][1] || days[0][2];
  const day = koreanDay ? '일월화수목금토'.indexOf(koreanDay) : ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].indexOf(days[0][3]?.toLowerCase() || '');
  return day < 0 ? null : { type: 'cron', config: { type: 'weekly', hour, minute, day } };
}

export function creationPlanHash(a: Automation): string {
  const { creationPlan: _metadata, ...definition } = a.definitionJson || {};
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(stable({
    id: a.id, userId: a.userId, projectId: a.projectId, name: a.name, description: a.description,
    prompt: a.prompt, model: a.model, workflow: a.workflow, jobType: a.jobType, scopeType: a.scopeType,
    mode: a.mode, targetId: a.targetId, cwd: a.cwd, triggerType: a.triggerType,
    cronConfig: a.cronConfig, onceAt: a.onceAt, timezone: a.timezone, timeoutSeconds: a.timeoutSeconds,
    riskLevel: a.riskLevel, definition,
  }))).digest('hex');
}
function assertProject(project: Awaited<ReturnType<typeof getProject>>): asserts project is NonNullable<Awaited<ReturnType<typeof getProject>>> & { rootPath: string } {
  if (!project || project.archived || project.lifecycleStatus !== 'active' || !project.rootPath) throw new AutomationPlanError('활성 Agent Workspace를 선택해 주세요.', 409);
}
export async function previewAutomationCreation(raw: unknown, actor: AutomationPlanActor, now = new Date()) {
  const parsed = createPlanInputSchema.safeParse(raw);
  if (!parsed.success) throw new AutomationPlanError('요청 형식 또는 실행 시각이 올바르지 않습니다.');
  const input = parsed.data;
  const access = await authorizeAutomationMutation({ actor, mutation: { projectId: input.projectId, jobType: 'ai_prompt', scopeType: 'project', definitionJson: {} } });
  if (!access.allowed) throw new AutomationPlanError(access.message || 'forbidden', access.status || 403);
  const project = await getProject(input.projectId); assertProject(project);
  try { validateScheduleTimezone(input.timezone); } catch { throw new AutomationPlanError('유효한 IANA 시간대가 필요합니다.'); }
  // Reject executable multi-stage/conditional promises, not ordinary business prose.
  if (/조건부\s*(AI|실행)|(?:실패|변경|오류).{0,12}(?:때만|경우에만)|(?:경우|넘으면|초과하면|이상이면|이하면|때만|그때만|할\s*때만).{0,20}(?:실행|보내|알림|보고)|(?:if|only when).{0,30}(?:fail|chang|error)|(?:오류|실패).{0,20}(?:있으면|나면|발생하면)|(?:이메일|메일|email|e-mail).{0,30}(?:보내|발송|전송|send|deliver)|(?:보내|발송|전송).{0,30}(?:이메일|메일|email|e-mail)|(?:send|deliver).{0,30}(?:email|mail)|웹훅|webhook|DAG|shell\s+command/i.test(input.request)) {
    return { kind: 'unsupported' as const, message: '첫 버전은 단일 AI 작업과 시간·수동 트리거만 지원합니다. 조건부 실행·이메일 발송·웹훅·다단계 계획은 활성화하지 않습니다.' };
  }
  const inferred = compileCreationTrigger(input.request);
  // Explicit clarification may supply missing timing, but must not silently
  // override a schedule that was already stated in the request.
  const hasTimeWords = /\b\d{1,2}:\d{2}\b|\d{1,2}\s*시|\d+\s*(분|시간)마다|매일|매주|평일|daily|weekly|weekdays|every|manual|수동/i.test(input.request);
  if (input.trigger && hasTimeWords && (!inferred || JSON.stringify(inferred) !== JSON.stringify(input.trigger))) {
    return { kind: 'clarification' as const, field: 'trigger', message: '요청의 실행 시각과 선택한 시각이 다릅니다. 요청을 고친 뒤 다시 검토해 주세요.' };
  }
  const trigger = input.trigger || inferred;
  if (!trigger) return { kind: 'clarification' as const, field: 'trigger', message: '언제 실행할지 명확히 선택해 주세요. 요청에서 시각을 임의로 추정하지 않습니다.' };
  if (trigger.type === 'once' && new Date(trigger.at).getTime() <= now.getTime()) throw new AutomationPlanError('한 번 실행할 시각은 미래여야 합니다.');
  let model = 'preset/core';
  if (input.modelMode === 'session') {
    if (!input.sourceSessionId) throw new AutomationPlanError('이어갈 세션을 선택해 주세요.');
    const allowed = await canAccessSession(input.sourceSessionId, actor.userId, actor.role || 'member');
    if (!allowed.allowed) throw new AutomationPlanError('세션에 접근할 수 없습니다.', 403);
    const session = await getSession(input.sourceSessionId);
    if (!session || session.projectId !== input.projectId || session.engine !== 'pi' || !session.modelUsed) throw new AutomationPlanError('이 Workspace의 유효한 Pi 세션 모델만 이어갈 수 있습니다.');
    model = persistPiSessionChoice(session.modelUsed);
  }
  const runtimeModel = resolveAutomationModel(model);
  if (!isSelectablePiModelId(runtimeModel)) throw new AutomationPlanError('선택한 모델을 현재 서버에서 사용할 수 없습니다.', 409);
  let executionReadiness;
  try {
    executionReadiness = await inspectAutomationCreationReadiness({ projectId: input.projectId, userId: actor.userId, rootPath: project!.rootPath });
  } catch {
    // Never expose host paths or raw authority errors in the public API.
    throw new AutomationPlanError('현재 계정의 Agent 실행 권한 또는 Workspace 경로를 확인할 수 없습니다.', 409);
  }
  const name = input.name || input.request.split('\n')[0].slice(0, 80);
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  // Derive the preview from the same schedule clock used by the scheduler.
  // A manual trigger has no occurrence; a one-shot trigger has exactly one.
  const nextRunTimes: string[] = [];
  if (trigger.type === 'once') nextRunTimes.push(trigger.at);
  if (trigger.type === 'cron') {
    let cursor = now;
    for (let i = 0; i < 3; i++) {
      cursor = calculateZonedNextRun(trigger.config, cursor, input.timezone);
      nextRunTimes.push(cursor.toISOString());
    }
  }
  const automation = await createAutomation({
    userId: actor.userId, projectId: input.projectId, name, description: input.request.slice(0, 1000), prompt: input.request,
    model, workflow: 'default', jobType: 'ai_prompt', scopeType: 'project', mode: 'spawn', enabled: false,
    timezone: input.timezone, triggerType: trigger.type, cronConfig: trigger.type === 'cron' ? trigger.config : undefined,
    onceAt: trigger.type === 'once' ? trigger.at : undefined,
    definitionJson: { source: 'creation-plan-v1', creationPlan: { status: 'draft', expiresAt, modelMode: input.modelMode } },
  });
  return { kind: 'plan' as const, automation, proposalHash: creationPlanHash(automation), expiresAt,
    runtimeModel, projectName: project!.name, modelMode: input.modelMode,
    nextRunAt: nextRunTimes[0] || null, nextRunTimes,
    readiness: {
      workspace: 'active' as const,
      createPermission: 'allowed' as const,
      modelSelection: 'selectable' as const,
      ...executionReadiness,
      executionAndProvider: 'not_verified' as const,
      dataAndWriteScope: 'not_verified' as const,
    },
    warnings: ['확인 후 예약이 활성화됩니다. AI 실행에는 비용이 발생하며, 도구 사용에는 기존 Workspace 권한이 적용됩니다.', '모델 제공자의 실제 인증, 실행기 상태, 요청에 쓰인 데이터 원천과 도구별 쓰기 권한은 이 계획에서 검증되지 않았습니다. 실행 시 별도 권한 검사를 적용합니다.', '결과는 자동화 실행 이력에서 확인합니다. 이메일이나 외부 보고 채널은 새로 설정하지 않습니다.'] };
}

export async function activateAutomationCreation(id: string, proposalHash: string, actor: AutomationPlanActor, confirmed: boolean, now = new Date()) {
  if (!confirmed || !/^[a-f0-9]{64}$/.test(proposalHash)) throw new AutomationPlanError('검토한 계획에 대한 명시적 확인이 필요합니다.');
  return transaction(async client => {
    const a = await getAutomationForUpdateInTransaction(client, id);
    if (!a) throw new AutomationPlanError('계획을 찾을 수 없습니다.', 404);
    const access = await canAccessAutomationJob(a, actor.userId, actor.role, 'edit');
    if (!access.allowed || a.userId !== actor.userId) throw new AutomationPlanError('계획 작성자만 확인할 수 있습니다.', 403);
    const meta = a.definitionJson.creationPlan as any;
    if (!meta || !['draft','activated'].includes(meta.status) || creationPlanHash(a) !== proposalHash || a.status === 'archived') throw new AutomationPlanError('계획이 변경되었습니다. 다시 검토해 주세요.', 409);
    if (meta.status === 'activated') {
      if (meta.proposalHash !== proposalHash) throw new AutomationPlanError('확인 기록이 일치하지 않습니다.', 409);
      return { automation: a, replayed: true };
    }
    if (a.enabled || !Number.isFinite(Date.parse(meta.expiresAt)) || Date.parse(meta.expiresAt) <= now.getTime()) throw new AutomationPlanError('계획이 만료되었거나 변경되었습니다. 다시 검토해 주세요.', 409);
    if (a.onceAt && Date.parse(a.onceAt) <= now.getTime()) throw new AutomationPlanError('예정 시각이 지났습니다. 다시 검토해 주세요.', 409);
    const policy = await authorizeAutomationMutation({ actor, existing: a });
    if (!policy.allowed) throw new AutomationPlanError(policy.message || 'forbidden', policy.status || 403);
    const project = await getProject(a.projectId!); assertProject(project);
    if (project!.rootPath !== a.cwd) throw new AutomationPlanError('Workspace 경로가 변경되었습니다. 다시 검토해 주세요.', 409);
    if (!isSelectablePiModelId(resolveAutomationModel(a.model))) throw new AutomationPlanError('현재 모델을 사용할 수 없습니다.', 409);
    try {
      await inspectAutomationCreationReadiness({ projectId: a.projectId!, userId: actor.userId, rootPath: project!.rootPath });
    } catch {
      throw new AutomationPlanError('현재 계정의 Agent 실행 권한 또는 Workspace 경로를 확인할 수 없습니다.', 409);
    }
    const automation = await activateCreationPlanInTransaction(client, id, {
      enabled: true, updatedByUserId: actor.userId,
      definitionJson: { ...a.definitionJson, creationPlan: { ...meta, status: 'activated', confirmedAt: now.toISOString(), proposalHash } },
    });
    return { automation, replayed: false };
  });
}
