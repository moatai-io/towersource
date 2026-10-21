import path from 'node:path';
import { verifyCanonicalFileWriteGrant, type CanonicalFileWriteScope } from '../runtime-box/canonical-file-write-grant.js';
import type { KeyObject } from 'node:crypto';
import { getUserAuthState } from '../auth/auth.js';
import { isDotfileDenied, isPathWritableByRole } from '../pm/project-access.js';
import { resolveCurrentProjectWorkspaceWrite, type ProjectWorkspaceFileReference } from './project-workspace-files.js';
import { sendCanonicalTextWrite } from '../runtime-box/canonical-file-write-transport.js';

/** Internal direct-user composition, not a route or executor selector.
 * target must come from trusted deployment configuration, never a user payload.
 * It must execute on the canonical host under the approved work identity. No
 * current caller selects this path automatically; ordinary writes are unchanged.
 * Worker-side current authority, protected roots and persistent replay storage
 * must be installed before activation. Agent-grant access is a separate policy.
 */
export async function delegateCanonicalTextWrite(input: {
 reference: ProjectWorkspaceFileReference; actorUserId: number; content: string; exclusive?: boolean;
 target: { workerId: string; baseUrl: string; secret: string; signingKey: KeyObject };
}): Promise<{ storageKind: 'host'; bytesWritten: number }> {
 const reference = await authorizeCanonicalTextWrite(input);
 const result = await sendCanonicalTextWrite({ ...input.target, projectId: reference.projectId,
 projectRoot: reference.projectRoot, relativePath: reference.relativePath, actorUserId: input.actorUserId,
 mode: input.exclusive ? 'exclusive' : 'replace', content: input.content });
 return { storageKind: 'host', bytesWritten: result.bytesWritten };
}

/** Shared current direct-user policy, used before issuance and on signed recheck. */
async function authorizeCanonicalTextWrite(input: { reference: ProjectWorkspaceFileReference; actorUserId: number }) {
 const reference = await resolveCurrentProjectWorkspaceWrite({ reference: input.reference, actorUserId: input.actorUserId });
 if (reference.workerAuthority) throw new Error('CANONICAL_WRITE_HOST_REQUIRED');
 const auth = await getUserAuthState(input.actorUserId);
 if (!auth || auth.disabled || auth.approvalStatus !== 'active') throw new Error('CANONICAL_WRITE_ACCESS_REVOKED');
 if (isDotfileDenied(reference.hostPath) || !await isPathWritableByRole(reference.hostPath, input.actorUserId, auth.role)) {
  throw new Error('CANONICAL_WRITE_PATH_DENIED');
 }
 return reference;
}

/** Backend-only callback service. authenticatedWorkerId must come from current
 * Worker identity middleware, not JSON. verificationKey is trusted configuration.
 * No write, grant issuance, DB access on Worker, or audience expansion occurs here.
 */
export async function recheckCanonicalTextWrite(input: {
 authenticatedWorkerId: string; verificationKey: KeyObject; token: string; scope: CanonicalFileWriteScope;
}): Promise<void> {
 const { scope } = verifyCanonicalFileWriteGrant({ verificationKey: input.verificationKey, token: input.token, expected: input.scope });
 if (scope.workerId !== input.authenticatedWorkerId) throw new Error('CANONICAL_WRITE_WORKER_MISMATCH');
 await authorizeCanonicalTextWrite({ actorUserId: scope.actorUserId, reference: {
  projectId: scope.projectId, projectRoot: scope.projectRoot, relativePath: scope.relativePath,
  hostPath: path.join(scope.projectRoot, scope.relativePath),
 } });
}
