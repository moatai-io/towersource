import crypto from 'crypto';
import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
const resolveFileSource = vi.fn();
const assertFileDestination = vi.fn();
const createSessionAttachmentFromPath = vi.fn();
const deleteSessionAttachment = vi.fn();
const createPersonalBinaryFileFromPath = vi.fn();
const archivePersonalFile = vi.fn();

vi.mock('../../db/pg-repo.js', () => ({ queryOne }));
vi.mock('./file-exchange-providers.js', () => ({
  resolveFileSource,
  assertFileDestination,
  reserveUniqueName: vi.fn(),
}));
vi.mock('../session-attachments/session-attachment-store.js', () => ({ createSessionAttachmentFromPath, deleteSessionAttachment }));
vi.mock('../personal-space/personal-space-store.js', () => ({ createPersonalBinaryFileFromPath, archivePersonalFile }));
vi.mock('../room/channel-shared-files.js', () => ({ addChannelSharedFile: vi.fn(), deleteChannelSharedFileRecord: vi.fn() }));
vi.mock('../pm/project-manager.js', () => ({ getProject: vi.fn() }));
vi.mock('../../config.js', () => ({ config: { workspaceRoot: '/workspace', dataDir: '/tmp/tower-file-exchange-tests' } }));

const fixturePath = new URL(import.meta.url).pathname;
const fixtureSha256 = crypto.createHash('sha256').update(readFileSync(fixturePath)).digest('hex');

const { confirmFileTransferPlan, executeFileTransfer, inspectFileTransfer, recoverStaleFileTransfer } = await import('./file-exchange-service.js');

const actor = { userId: 7, role: 'member' };
const plan = {
  id: '11111111-1111-4111-8111-111111111111', actor_user_id: 7,
  principal_ref: { kind: 'user' }, delegated_by_user_id: 7,
  source_ref: { scope: 'personal', uri: 'personal://files/a.pdf' },
  destination_ref: { scope: 'project', projectId: 'p1' }, mode: 'workspace_copy',
  source_name: 'a.pdf', source_mime_type: 'application/pdf', source_size_bytes: 3,
  source_version: '4', source_sha256: fixtureSha256, confirmation_required: true,
  confirmed_at: null, confirmed_by_user_id: null,
  status: 'pending', expires_at: new Date(Date.now() + 60_000).toISOString(),
};

function receiptRow(status: string, failureCode: string | null) {
  return {
    id: '22222222-2222-4222-8222-222222222222', plan_id: plan.id, actor_user_id: 7,
    principal_ref: plan.principal_ref, delegated_by_user_id: 7,
    source_ref: plan.source_ref, destination_ref: plan.destination_ref, result_ref: null,
    mode: plan.mode, status, failure_code: failureCode, failure_stage: 'source.revalidate',
    created_at: new Date().toISOString(),
  };
}

describe('File Exchange execute revalidation', () => {
  beforeEach(() => {
    for (const mock of [queryOne, resolveFileSource, assertFileDestination, createSessionAttachmentFromPath, deleteSessionAttachment, createPersonalBinaryFileFromPath, archivePersonalFile]) mock.mockReset();
    assertFileDestination.mockResolvedValue(undefined);
  });

  it('cleans a materialized source after inspect persists its plan', async () => {
    const cleanup = vi.fn();
    resolveFileSource.mockResolvedValue({
      ref: plan.source_ref, name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 3,
      version: '4', sha256: fixtureSha256, storagePath: fixturePath, cleanup,
    });
    queryOne.mockResolvedValueOnce(plan);

    await inspectFileTransfer(actor, { source: plan.source_ref, destination: plan.destination_ref });

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('cleans a materialized source when inspect destination validation fails', async () => {
    const cleanup = vi.fn();
    resolveFileSource.mockResolvedValue({
      ref: plan.source_ref, name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 3,
      version: '4', sha256: fixtureSha256, storagePath: fixturePath, cleanup,
    });
    assertFileDestination.mockRejectedValueOnce(new Error('destination denied'));

    await expect(inspectFileTransfer(actor, { source: plan.source_ref, destination: plan.destination_ref })).rejects.toThrow('destination denied');

    expect(cleanup).toHaveBeenCalledOnce();
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('records authenticated confirmation only for the actor-owned active plan', async () => {
    queryOne.mockResolvedValueOnce({ id: plan.id });

    await expect(confirmFileTransferPlan(actor, plan.id)).resolves.toBeUndefined();

    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('confirmed_by_user_id'), [plan.id, actor.userId]);
  });

  it('does not claim a confirmation-required plan before server-recorded confirmation', async () => {
    queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(plan);
    await expect(executeFileTransfer(actor, plan.id)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(queryOne).toHaveBeenCalledTimes(2);
    expect(resolveFileSource).not.toHaveBeenCalled();
  });

  it('records stale and writes no destination when source version/hash changed after inspect', async () => {
    const confirmedPlan = { ...plan, confirmed_at: new Date().toISOString(), confirmed_by_user_id: actor.userId };
    queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(confirmedPlan)
      .mockResolvedValueOnce({ ...confirmedPlan, status: 'executing' })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(receiptRow('stale', 'STALE'));
    resolveFileSource.mockResolvedValue({
      ref: plan.source_ref, name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 3,
      version: '5', sha256: 'new-hash', storagePath: '/private/a.pdf',
    });

    const receipt = await executeFileTransfer(actor, plan.id);

    expect(receipt.status).toBe('stale');
    expect(assertFileDestination).not.toHaveBeenCalled();
    expect(queryOne.mock.calls.some(([sql]) => String(sql).includes('file_exchange_receipts'))).toBe(true);
  });

  it('compensates a destination snapshot when completed receipt persistence fails', async () => {
    const sessionPlan = {
      ...plan,
      destination_ref: { scope: 'session', sessionId: 's1' },
      mode: 'snapshot',
      confirmation_required: false,
    };
    queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(sessionPlan)
      .mockResolvedValueOnce({ ...sessionPlan, status: 'executing' })
      .mockRejectedValueOnce(new Error('receipt database unavailable'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        ...receiptRow('failed', 'FAILED'),
        destination_ref: sessionPlan.destination_ref,
        mode: sessionPlan.mode,
        failure_stage: 'execute',
      });
    resolveFileSource.mockResolvedValue({
      ref: plan.source_ref, name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 3,
      version: '4', sha256: fixtureSha256, storagePath: fixturePath,
    });
    createSessionAttachmentFromPath.mockResolvedValue({ id: 'a1', uri: 'session://attachments/a1', name: 'a.pdf' });

    const receipt = await executeFileTransfer(actor, sessionPlan.id);

    expect(deleteSessionAttachment).toHaveBeenCalledWith(actor.userId, 's1', 'a1');
    expect(receipt.status).toBe('failed');
    expect(receipt.failureCode).toBe('FAILED');
  });

  it('copies a project result to Personal Space after confirmation', async () => {
    const personalPlan = {
      ...plan,
      confirmed_at: new Date().toISOString(),
      confirmed_by_user_id: actor.userId,
      source_ref: { scope: 'project', projectId: 'p1', relativePath: 'final/a.pdf' },
      destination_ref: { scope: 'personal', relativeDirectory: 'files' },
      mode: 'snapshot',
      confirmation_required: true,
    };
    queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(personalPlan)
      .mockResolvedValueOnce({ ...personalPlan, status: 'executing' })
      .mockResolvedValueOnce({
        ...receiptRow('completed', null),
        source_ref: personalPlan.source_ref,
        destination_ref: personalPlan.destination_ref,
        result_ref: { scope: 'personal', uri: 'personal://files/a.pdf', name: 'a.pdf' },
        mode: personalPlan.mode,
        failure_stage: null,
      })
      .mockResolvedValueOnce(undefined);
    resolveFileSource.mockResolvedValue({
      ref: personalPlan.source_ref, name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 3,
      version: '4', sha256: fixtureSha256, storagePath: fixturePath,
    });
    createPersonalBinaryFileFromPath.mockResolvedValue({ uri: 'personal://files/a.pdf', name: 'a.pdf' });

    const receipt = await executeFileTransfer(actor, personalPlan.id);

    expect(createPersonalBinaryFileFromPath).toHaveBeenCalledWith(actor.userId, 'files/a.pdf', expect.any(String), 'application/pdf');
    expect(receipt.status).toBe('completed');
    expect(receipt.result).toMatchObject({ scope: 'personal', uri: 'personal://files/a.pdf' });
  });

  it('returns the durable receipt on retry without reading or copying the source again', async () => {
    const completed = { ...receiptRow('completed', null), result_ref: { scope: 'project', relativePath: 'uploads/a.pdf' }, failure_stage: null };
    queryOne.mockResolvedValueOnce(completed);

    const receipt = await executeFileTransfer(actor, plan.id);

    expect(receipt.id).toBe(completed.id);
    expect(resolveFileSource).not.toHaveBeenCalled();
    expect(createPersonalBinaryFileFromPath).not.toHaveBeenCalled();
    expect(queryOne).toHaveBeenCalledTimes(1);
  });

  it('marks an abandoned executing plan uncertain without replaying the destination write', async () => {
    const executing = { ...plan, status: 'executing' };
    queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(executing)
      .mockResolvedValueOnce(receiptRow('failed', 'UNCERTAIN_EXECUTION'));

    const receipt = await recoverStaleFileTransfer(actor, plan.id);

    expect(receipt?.failureCode).toBe('UNCERTAIN_EXECUTION');
    expect(resolveFileSource).not.toHaveBeenCalled();
    expect(queryOne.mock.calls.some(([sql]) => String(sql).includes("status = 'executing'") && String(sql).includes("INTERVAL '5 minutes'"))).toBe(true);
  });

  it('keeps a recent executing plan in conflict instead of replaying it', async () => {
    queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...plan, status: 'executing' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(executeFileTransfer(actor, plan.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(resolveFileSource).not.toHaveBeenCalled();
  });

  it('records denied when destination authority is revoked after inspect', async () => {
    const confirmedPlan = { ...plan, confirmed_at: new Date().toISOString(), confirmed_by_user_id: actor.userId };
    queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(confirmedPlan)
      .mockResolvedValueOnce({ ...plan, status: 'executing' })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ...receiptRow('denied', 'FORBIDDEN'), failure_stage: 'execute' });
    resolveFileSource.mockResolvedValue({
      ref: plan.source_ref, name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 3,
      version: '4', sha256: 'old-hash', storagePath: '/private/a.pdf',
    });
    const { FileExchangeError } = await import('./file-exchange-types.js');
    assertFileDestination.mockRejectedValue(new FileExchangeError('FORBIDDEN', 'write access revoked'));

    const receipt = await executeFileTransfer(actor, plan.id);

    expect(receipt.status).toBe('denied');
    expect(receipt.failureCode).toBe('FORBIDDEN');
  });
});
