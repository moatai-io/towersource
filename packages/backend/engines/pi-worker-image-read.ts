/** Worker-authoritative image reads. Never chmod or overwrite the shared source. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isPathAccessible } from '../services/pm/project-access.js';
import { getUserAuthState } from '../services/auth/auth.js';
import { resolveWorkerFileAuthorityForHostPath, downloadWorkerProjectFile } from '../services/runtime-box/workbench-project-file-authority.js';
import { prepareFileRepresentation, readPreparedVisionImage } from '../services/content-safety/file-representation-gateway.js';

export async function readWorkerImage(source: string, ctx: { cwd: string; projectId?: string; userId?: number }) {
  if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(source) || !ctx.projectId || !ctx.userId) return null;
  const target = source.startsWith('~/') ? path.resolve(os.homedir(), source.slice(2)) : path.resolve(ctx.cwd, source);
  const authority = await resolveWorkerFileAuthorityForHostPath(target);
  if (!authority) return null;
  // A resolved Worker binding is routing, not authorization.
  if (authority.projectId !== ctx.projectId) throw new Error('WORKER_IMAGE_PROJECT_MISMATCH');
  const actor = await getUserAuthState(ctx.userId);
  if (!actor || actor.disabled || actor.approvalStatus !== 'active'
    || !await isPathAccessible(target, ctx.userId, actor.role)) throw new Error('WORKER_IMAGE_ACCESS_DENIED');
  const bytes = await downloadWorkerProjectFile({ authority, actorUserId: ctx.userId, maxBytes: 20 * 1024 * 1024 });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-worker-image-read-'));
  try {
    const localPath = path.join(temporary, path.basename(target));
    await fs.writeFile(localPath, bytes, { flag: 'wx', mode: 0o600 });
    const prepared = await prepareFileRepresentation(localPath, { cwd: temporary });
    const image = await readPreparedVisionImage(prepared);
    if (!image) throw new Error('WORKER_IMAGE_CONTENT_NOT_IMAGE');
    return { content: [image], details: { workerImage: true, name: path.basename(target), sizeBytes: bytes.length } };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
