// Owns: inspect, execute, and receipt lifecycle for cross-scope file delivery. Public API below. See README.md.
import crypto from 'crypto';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import path from 'path';
import { config } from '../../config.js';
import { queryOne } from '../../db/pg-repo.js';
import { createSessionAttachmentFromPath, deleteSessionAttachment } from '../session-attachments/session-attachment-store.js';
import { archivePersonalFile, createPersonalBinaryFileFromPath } from '../personal-space/personal-space-store.js';
import { addChannelSharedFile, deleteChannelSharedFileRecord } from '../room/channel-shared-files.js';
import { getProject } from '../pm/project-manager.js';
import { decideTransferPolicy } from './file-exchange-policy.js';
import { assertFileDestination, reserveUniqueName, resolveFileSource, type ResolvedFileSource } from './file-exchange-providers.js';
import type {
  FileExchangeActor,
  FileTransferIntent,
  FileTransferPlan,
  FileTransferReceipt,
  FileSourceRef,
  FileDestinationRef,
  FileTransferMode,
} from './file-exchange-types.js';
import { FileExchangeError } from './file-exchange-types.js';

interface PlanRow {
  id: string;
  actor_user_id: number;
  principal_ref: FileExchangeActor['principal'];
  delegated_by_user_id: number | null;
  source_ref: FileSourceRef;
  destination_ref: FileDestinationRef;
  mode: FileTransferMode;
  source_name: string;
  source_mime_type: string | null;
  source_size_bytes: string | number;
  source_version: string;
  source_sha256: string;
  confirmation_required: boolean;
  confirmed_at: string | null;
  confirmed_by_user_id: number | null;
  status: string;
  expires_at: string;
}

interface ReceiptRow {
  id: string;
  plan_id: string;
  actor_user_id: number;
  principal_ref: FileExchangeActor['principal'];
  delegated_by_user_id: number | null;
  source_ref: FileSourceRef;
  destination_ref: FileDestinationRef;
  result_ref: Record<string, unknown> | null;
  mode: FileTransferMode;
  status: FileTransferReceipt['status'];
  failure_code: string | null;
  failure_stage: string | null;
  created_at: string;
}

function planDocument(row: PlanRow, confirmationMessage: string | null): FileTransferPlan {
  return {
    id: row.id,
    source: row.source_ref,
    destination: row.destination_ref,
    mode: row.mode,
    sourceName: row.source_name,
    sourceMimeType: row.source_mime_type,
    sourceSizeBytes: Number(row.source_size_bytes),
    confirmationRequired: row.confirmation_required,
    confirmationMessage,
    expiresAt: row.expires_at,
  };
}

function receiptDocument(row: ReceiptRow): FileTransferReceipt {
  return {
    id: row.id,
    planId: row.plan_id,
    principal: row.principal_ref || { kind: 'user' },
    delegatedByUserId: Number(row.delegated_by_user_id || row.actor_user_id),
    source: row.source_ref,
    destination: row.destination_ref,
    result: row.result_ref,
    mode: row.mode,
    status: row.status,
    failureCode: row.failure_code,
    failureStage: row.failure_stage,
    createdAt: row.created_at,
  };
}

function validateIntent(intent: FileTransferIntent): void {
  if (!intent?.source?.scope || !intent?.destination?.scope) throw new FileExchangeError('INVALID', 'source와 destination이 필요합니다.');
  if (!['personal', 'session', 'channel', 'project'].includes(intent.source.scope)) throw new FileExchangeError('INVALID', '지원하지 않는 source입니다.');
  if (!['personal', 'session', 'channel', 'project'].includes(intent.destination.scope)) throw new FileExchangeError('INVALID', '지원하지 않는 destination입니다.');
}

/** Create a short-lived server-authored transfer plan after both providers authorize it. */
export async function inspectFileTransfer(actor: FileExchangeActor, intent: FileTransferIntent): Promise<FileTransferPlan> {
  validateIntent(intent);
  const principal = actor.principal || { kind: 'user' as const };
  if (principal.kind === 'agent' && (!principal.projectId || !principal.sessionId)) {
    throw new FileExchangeError('INVALID', 'Agent 파일 전달에는 Project와 Session provenance가 필요합니다.');
  }
  const policy = decideTransferPolicy(intent.source, intent.destination);
  const source = await resolveFileSource(actor, intent.source);
  await assertFileDestination(actor, intent.destination);
  const row = await queryOne<PlanRow>(
    `INSERT INTO file_exchange_plans
       (actor_user_id, principal_ref, delegated_by_user_id, source_ref, destination_ref, mode, source_name, source_mime_type,
        source_size_bytes, source_version, source_sha256, confirmation_required)
     VALUES ($1,$2::jsonb,$1,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *, expires_at::text`,
    [actor.userId, JSON.stringify(principal), JSON.stringify(intent.source), JSON.stringify(intent.destination), policy.mode, source.name,
      source.mimeType, source.sizeBytes, source.version, source.sha256, policy.confirmationRequired],
  );
  if (!row) throw new FileExchangeError('FAILED', '전달 계획을 만들지 못했습니다.', 'inspect.persist');
  return planDocument(row, policy.confirmationMessage);
}

/** Record one authenticated user's approval for this exact, still-pending plan. */
export async function confirmFileTransferPlan(actor: FileExchangeActor, planId: string): Promise<void> {
  const confirmed = await queryOne<{ id: string }>(
    `UPDATE file_exchange_plans
        SET confirmed_at = COALESCE(confirmed_at, NOW()),
            confirmed_by_user_id = COALESCE(confirmed_by_user_id, $2),
            updated_at = NOW()
      WHERE id = $1 AND actor_user_id = $2 AND status = 'pending' AND expires_at > NOW()
      RETURNING id`,
    [planId, actor.userId],
  );
  if (!confirmed) throw new FileExchangeError('CONFLICT', '확인할 수 있는 활성 파일 전달 계획이 없습니다.');
}

async function findReceiptByPlan(actor: FileExchangeActor, planId: string): Promise<FileTransferReceipt | null> {
  const row = await queryOne<ReceiptRow>(
    `SELECT *, created_at::text FROM file_exchange_receipts WHERE plan_id = $1 AND actor_user_id = $2`,
    [planId, actor.userId],
  );
  return row ? receiptDocument(row) : null;
}

async function insertReceipt(input: {
  plan: PlanRow;
  status: FileTransferReceipt['status'];
  confirmed: boolean;
  result?: Record<string, unknown> | null;
  failureCode?: string | null;
  failureStage?: string | null;
  orphanDetail?: Record<string, unknown> | null;
}): Promise<FileTransferReceipt> {
  const row = await queryOne<ReceiptRow>(
    `INSERT INTO file_exchange_receipts
       (plan_id, actor_user_id, principal_ref, delegated_by_user_id, source_ref, destination_ref, result_ref, mode, status,
        confirmation_recorded, source_sha256, failure_code, failure_stage, orphan_detail)
     VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14::jsonb)
     ON CONFLICT (plan_id) DO NOTHING
     RETURNING *, created_at::text`,
    [input.plan.id, input.plan.actor_user_id, JSON.stringify(input.plan.principal_ref || { kind: 'user' }),
      input.plan.delegated_by_user_id || input.plan.actor_user_id, JSON.stringify(input.plan.source_ref), JSON.stringify(input.plan.destination_ref),
      JSON.stringify(input.result ?? null), input.plan.mode, input.status, input.confirmed, input.plan.source_sha256,
      input.failureCode ?? null, input.failureStage ?? null, JSON.stringify(input.orphanDetail ?? null)],
  );
  if (row) return receiptDocument(row);
  const existing = await queryOne<ReceiptRow>(
    `SELECT *, created_at::text FROM file_exchange_receipts WHERE plan_id = $1 AND actor_user_id = $2`,
    [input.plan.id, input.plan.actor_user_id],
  );
  if (!existing) throw new FileExchangeError('FAILED', '전달 영수증을 기록하지 못했습니다.', 'receipt.persist');
  return receiptDocument(existing);
}

interface DestinationWrite {
  result: Record<string, unknown>;
  compensate: () => Promise<void>;
}

interface VerifiedTempCopy {
  path: string;
  sizeBytes: number;
}

async function copyToVerifiedTemp(source: ResolvedFileSource, expectedSha256: string, targetDir: string): Promise<VerifiedTempCopy> {
  await fs.mkdir(targetDir, { recursive: true });
  const tempPath = path.join(targetDir, `.tower-transfer-${crypto.randomUUID()}.tmp`);
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;
  try {
    await pipeline(
      createReadStream(source.storagePath),
      new Transform({
        transform(chunk, _encoding, callback) {
          sizeBytes += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }),
    );
    if (hash.digest('hex') !== expectedSha256) {
      throw new FileExchangeError('STALE', '승인 후 원본 파일이 변경되었습니다.', 'source.copy');
    }
    return { path: tempPath, sizeBytes };
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function commitVerifiedTemp(targetDir: string, requestedName: string, tempPath: string): Promise<{ name: string; path: string }> {
  const reserved = await reserveUniqueName(targetDir, requestedName);
  await reserved.handle.close();
  try {
    await fs.rename(tempPath, reserved.path);
    return { name: reserved.name, path: reserved.path };
  } catch (error) {
    await fs.rm(reserved.path, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function copyToDestination(actor: FileExchangeActor, plan: PlanRow, source: ResolvedFileSource): Promise<DestinationWrite> {
  const destination = plan.destination_ref;
  if (destination.scope === 'personal') {
    const relativeDirectory = (destination.relativeDirectory || 'files').replace(/\\/g, '/').replace(/^\/+/, '');
    const stagingDir = path.join(config.dataDir, 'upload-staging', 'file-exchange');
    const verified = await copyToVerifiedTemp(source, plan.source_sha256, stagingDir);
    try {
      const personal = await createPersonalBinaryFileFromPath(
        actor.userId,
        path.posix.join(relativeDirectory, plan.source_name),
        verified.path,
        plan.source_mime_type,
      );
      return {
        result: { scope: 'personal', uri: personal.uri, name: personal.name },
        compensate: () => archivePersonalFile(actor.userId, personal.uri),
      };
    } finally {
      await fs.rm(verified.path, { force: true }).catch(() => undefined);
    }
  }
  if (destination.scope === 'session') {
    const stagingDir = path.join(config.dataDir, 'upload-staging', 'file-exchange');
    const verified = await copyToVerifiedTemp(source, plan.source_sha256, stagingDir);
    try {
      const attachment = await createSessionAttachmentFromPath({
        userId: actor.userId,
        sessionId: destination.sessionId,
        name: plan.source_name,
        mimeType: plan.source_mime_type,
        sourcePath: verified.path,
      });
      return {
        result: { scope: 'session', sessionId: destination.sessionId, attachmentId: attachment.id, uri: attachment.uri, name: attachment.name },
        compensate: () => deleteSessionAttachment(actor.userId, destination.sessionId, attachment.id),
      };
    } finally {
      await fs.rm(verified.path, { force: true }).catch(() => undefined);
    }
  }

  if (destination.scope === 'channel') {
    const root = path.join(config.workspaceRoot, 'uploads', 'channels', destination.channelId);
    const verified = await copyToVerifiedTemp(source, plan.source_sha256, root);
    let committed: { name: string; path: string } | null = null;
    let registeredId: string | null = null;
    try {
      committed = await commitVerifiedTemp(root, plan.source_name, verified.path);
      const item = await addChannelSharedFile({
        channelId: destination.channelId,
        storagePath: committed.path,
        originalName: committed.name,
        mimeType: plan.source_mime_type,
        sizeBytes: verified.sizeBytes,
        uploadedBy: actor.userId,
      });
      registeredId = item.id;
      return {
        result: { scope: 'channel', channelId: destination.channelId, fileId: item.id, name: item.originalName },
        compensate: async () => {
          await deleteChannelSharedFileRecord(item.id);
          await fs.rm(committed!.path, { force: true });
        },
      };
    } catch (error) {
      if (registeredId) await deleteChannelSharedFileRecord(registeredId).catch(() => undefined);
      await fs.rm(committed?.path || verified.path, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  const project = await getProject(destination.projectId);
  if (!project?.rootPath) throw new FileExchangeError('NOT_FOUND', 'AI 팀원 작업공간을 찾지 못했습니다.', 'destination.resolve');
  const relativeDirectory = (destination.relativeDirectory || 'uploads').replace(/\\/g, '/').replace(/^\/+/, '');
  const targetDir = path.join(project.rootPath, relativeDirectory);
  const verified = await copyToVerifiedTemp(source, plan.source_sha256, targetDir);
  let committed: { name: string; path: string } | null = null;
  try {
    committed = await commitVerifiedTemp(targetDir, plan.source_name, verified.path);
    return {
      result: { scope: 'project', projectId: destination.projectId, relativePath: path.posix.join(relativeDirectory, committed.name), name: committed.name },
      compensate: () => fs.rm(committed!.path, { force: true }),
    };
  } catch (error) {
    await fs.rm(committed?.path || verified.path, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Close one abandoned execution without replaying a possibly completed side effect.
 * A stale executing row is uncertain, so recovery records a terminal failed receipt.
 */
export async function recoverStaleFileTransfer(actor: FileExchangeActor, planId: string): Promise<FileTransferReceipt | null> {
  const existing = await findReceiptByPlan(actor, planId);
  if (existing) return existing;
  const stale = await queryOne<PlanRow>(
    `UPDATE file_exchange_plans SET status = 'failed', updated_at = NOW()
      WHERE id = $1 AND actor_user_id = $2 AND status = 'executing'
        AND updated_at < NOW() - INTERVAL '5 minutes'
      RETURNING *, expires_at::text`,
    [planId, actor.userId],
  );
  if (!stale) return null;
  return insertReceipt({
    plan: stale,
    status: 'failed',
    confirmed: false,
    failureCode: 'UNCERTAIN_EXECUTION',
    failureStage: 'execute.recovery',
    orphanDetail: { manualReviewRequired: true },
  });
}

/** Execute one plan at most once, returning the durable receipt on safe retries. */
export async function executeFileTransfer(actor: FileExchangeActor, planId: string): Promise<FileTransferReceipt> {
  const prior = await findReceiptByPlan(actor, planId);
  if (prior) return prior;

  const plan = await queryOne<PlanRow>(
    `SELECT *, expires_at::text FROM file_exchange_plans WHERE id = $1 AND actor_user_id = $2`,
    [planId, actor.userId],
  );
  if (!plan) throw new FileExchangeError('NOT_FOUND', '전달 계획을 찾지 못했습니다.');
  if (plan.status === 'executing') {
    const recovered = await recoverStaleFileTransfer(actor, planId);
    if (recovered) return recovered;
    throw new FileExchangeError('CONFLICT', '다른 요청이 이 전달 계획을 실행 중입니다.');
  }
  if (plan.status !== 'pending' || new Date(plan.expires_at).getTime() <= Date.now()) {
    const terminal = await findReceiptByPlan(actor, planId);
    if (terminal) return terminal;
    throw new FileExchangeError('CONFLICT', '전달 계획이 종료되었지만 결과 영수증을 찾지 못했습니다.');
  }

  if (plan.confirmation_required && (!plan.confirmed_at || Number(plan.confirmed_by_user_id) !== actor.userId)) {
    throw new FileExchangeError('CONFIRMATION_REQUIRED', '이 파일 전달 계획에 대한 사용자 확인이 필요합니다.');
  }
  const confirmed = !plan.confirmation_required || Boolean(plan.confirmed_at && Number(plan.confirmed_by_user_id) === actor.userId);

  const claimed = await queryOne<PlanRow>(
    `UPDATE file_exchange_plans SET status = 'executing', updated_at = NOW()
      WHERE id = $1 AND actor_user_id = $2 AND status = 'pending' AND expires_at > NOW()
      RETURNING *, expires_at::text`,
    [plan.id, actor.userId],
  );
  if (!claimed) {
    const raced = await findReceiptByPlan(actor, planId);
    if (raced) return raced;
    throw new FileExchangeError('CONFLICT', '다른 요청이 이미 이 전달 계획을 실행했습니다.');
  }

  let destinationWrite: DestinationWrite | null = null;
  try {
    const source = await resolveFileSource(actor, plan.source_ref, { measureContent: false });
    if (source.version !== plan.source_version) {
      await queryOne(`UPDATE file_exchange_plans SET status = 'failed', updated_at = NOW() WHERE id = $1`, [plan.id]);
      return insertReceipt({ plan, status: 'stale', confirmed, failureCode: 'STALE', failureStage: 'source.revalidate' });
    }
    await assertFileDestination(actor, plan.destination_ref);
    destinationWrite = await copyToDestination(actor, plan, source);
    const receipt = await insertReceipt({ plan, status: 'completed', confirmed, result: destinationWrite.result });
    await queryOne(`UPDATE file_exchange_plans SET status = 'completed', updated_at = NOW() WHERE id = $1`, [plan.id])
      .catch(error => console.warn('[file-exchange] receipt persisted but plan completion update failed:', error));
    return receipt;
  } catch (error: any) {
    let orphanDetail: Record<string, unknown> | null = null;
    if (destinationWrite) {
      try {
        await destinationWrite.compensate();
      } catch (compensationError) {
        orphanDetail = {
          compensationFailed: true,
          message: compensationError instanceof Error ? compensationError.message : 'Unknown compensation error',
        };
      }
    }
    await queryOne(`UPDATE file_exchange_plans SET status = 'failed', updated_at = NOW() WHERE id = $1`, [plan.id]).catch(() => undefined);
    const code = error instanceof FileExchangeError ? error.code : 'FAILED';
    const status: FileTransferReceipt['status'] = code === 'FORBIDDEN' ? 'denied' : code === 'STALE' ? 'stale' : 'failed';
    return insertReceipt({ plan, status, confirmed, failureCode: code, failureStage: error?.stage || 'execute', orphanDetail });
  }
}

/** Read a durable receipt owned by the current actor. */
export async function getFileTransferReceipt(actor: FileExchangeActor, receiptId: string): Promise<FileTransferReceipt> {
  const row = await queryOne<ReceiptRow>(
    `SELECT *, created_at::text FROM file_exchange_receipts WHERE id = $1 AND actor_user_id = $2`,
    [receiptId, actor.userId],
  );
  if (!row) throw new FileExchangeError('NOT_FOUND', '전달 영수증을 찾지 못했습니다.');
  return receiptDocument(row);
}
