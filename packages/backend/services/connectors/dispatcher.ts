import type { Pool } from 'pg';
import { getProject } from '../pm/project-manager.js';
import { canCreateInProject } from '../pm/project-access.js';
import { getUserRole } from '../auth/auth.js';
import { createTask } from '../task/task-manager.js';
import { spawnTask } from '../task/task-runner.js';
import { broadcastToAll } from '../../routes/ws-handler.js';
import type { WebhookDispatchBinding } from './contract.js';
import { WebhookEventStore } from './store.js';

export async function dispatchOneWebhookEvent(pool: Pool, resolveBinding: (connectorId: string) => WebhookDispatchBinding | null): Promise<boolean> {
  const store = new WebhookEventStore(pool);
  const claim = await store.claim();
  if (!claim) return false;
  const binding = resolveBinding(claim.connectorId);
  if (!binding || binding.resolver.provider !== claim.provider) {
    await store.settle(claim, { status: 'needs_review', reason: 'webhook_dispatch_binding_missing' }); return true;
  }
  try {
    const decision = await binding.resolver.resolve(claim.event);
    if (decision.kind === 'ignore') {
      await store.settle(claim, { status: 'ignored', reason: decision.reason, resourceKey: decision.resourceKey }); return true;
    }
    const project = await getProject(binding.projectId);
    if (!project || project.archived || project.lifecycleStatus !== 'active' || !project.rootPath) throw new Error('webhook_project_unavailable');
    const runAsRole = await getUserRole(binding.runAsUserId);
    const authority = runAsRole ? await canCreateInProject(project.id, binding.runAsUserId, runAsRole) : { allowed: false as const };
    if (!authority.allowed) throw new Error('webhook_run_as_not_authorized');
    const task = await createTask(decision.title, decision.prompt, project.rootPath, binding.runAsUserId,
      undefined, undefined, 'auto', undefined, project.id, undefined, 'notification');
    await store.settle(claim, { status: 'task_created', taskId: task.id, route: decision.route, resourceKey: decision.resourceKey });
    broadcastToAll({ type: 'task_created', task });
    void spawnTask(task.id, (type, data) => broadcastToAll({ type, ...data }), binding.runAsUserId)
      .catch(error => console.error('[webhook-dispatcher] Task spawn failed after durable task creation', task.id, error));
  } catch (error: any) {
    await store.settle(claim, { status: 'needs_review', reason: String(error?.message || error).slice(0, 500) });
  }
  return true;
}

export function startWebhookDispatcher(input: { pool: Pool; resolveBinding: (connectorId: string) => WebhookDispatchBinding | null; intervalMs?: number }): () => void {
  let stopped = false; let timer: NodeJS.Timeout | undefined; let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try { while (!stopped && await dispatchOneWebhookEvent(input.pool, input.resolveBinding)) {} }
    catch (error) { console.error('[webhook-dispatcher] Dispatch tick failed', error); }
    finally { running = false; if (!stopped) timer = setTimeout(tick, input.intervalMs ?? 1_000); }
  };
  void tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
