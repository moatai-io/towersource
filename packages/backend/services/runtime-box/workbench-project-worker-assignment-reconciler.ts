/**
 * Owns: binding-last orchestration for one claimed Project Worker assignment.
 * Public API: reconcileClaimedProjectWorkerAssignment.
 */
import type { ProjectWorkerAssignmentDesire } from './workbench-project-worker-assignment.js';

export interface ProjectWorkerAssignmentReconcilerDependencies {
  prepareWorker(input: { assignment: ProjectWorkerAssignmentDesire }): Promise<{ rollback(): Promise<void> }>;
  verifyWorker(input: { assignment: ProjectWorkerAssignmentDesire }): Promise<void>;
  activateBinding(input: { assignment: ProjectWorkerAssignmentDesire }): Promise<void>;
  complete(input: { assignment: ProjectWorkerAssignmentDesire }): Promise<boolean>;
  fail(input: { assignment: ProjectWorkerAssignmentDesire; error: string }): Promise<boolean>;
  recoveryRequired(input: { assignment: ProjectWorkerAssignmentDesire; error: string }): Promise<boolean>;
}

/**
 * Reconcile one already-claimed desire. Binding activation is deliberately last,
 * after Worker scope, restart, heartbeat, and smoke have succeeded.
 */
export async function reconcileClaimedProjectWorkerAssignment(
  assignment: ProjectWorkerAssignmentDesire,
  dependencies: ProjectWorkerAssignmentReconcilerDependencies,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (assignment.status !== 'preparing' || !assignment.lease_owner) {
    throw new Error('PROJECT_WORKER_ASSIGNMENT_NOT_CLAIMED');
  }
  let prepared: Awaited<ReturnType<ProjectWorkerAssignmentReconcilerDependencies['prepareWorker']>> | undefined;
  let bindingActivated = false;
  try {
    prepared = await dependencies.prepareWorker({ assignment });
    await dependencies.verifyWorker({ assignment });
    await dependencies.activateBinding({ assignment });
    bindingActivated = true;
    if (!await dependencies.complete({ assignment })) throw new Error('PROJECT_WORKER_ASSIGNMENT_COMPLETE_REJECTED');
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!bindingActivated && prepared) {
      try { await prepared.rollback(); }
      catch (rollbackError) {
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        await dependencies.fail({ assignment, error: `${message}; rollback failed: ${rollbackMessage}` });
        return { ok: false, error: `${message}; rollback failed: ${rollbackMessage}` };
      }
    }
    if (bindingActivated) await dependencies.recoveryRequired({ assignment, error: message });
    else await dependencies.fail({ assignment, error: message });
    return { ok: false, error: message };
  }
}
