import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = import.meta.dirname;
const service = fs.readFileSync(path.join(root, 'file-exchange-service.ts'), 'utf8');
const providers = fs.readFileSync(path.join(root, 'file-exchange-providers.ts'), 'utf8');
const route = fs.readFileSync(path.resolve(root, '../../routes/file-exchange-api.ts'), 'utf8');
const decision = fs.readFileSync(path.resolve(root, '../../../../workspace/decisions/2026-07-14-file-exchange-deep-module.md'), 'utf8');
const tool = fs.readFileSync(path.resolve(root, '../../engines/pi-file-exchange-tool.ts'), 'utf8');
const migration = fs.readFileSync(path.resolve(root, '../../db/migrations/143_file_exchange_principal_provenance.sql'), 'utf8');
const confirmationMigration = fs.readFileSync(path.resolve(root, '../../db/migrations/144_file_exchange_confirmation_intents.sql'), 'utf8');

describe('File Exchange deep-module contracts', () => {
  it('uses a server-authored inspect/execute flow with durable receipts', () => {
    expect(service).toContain('inspectFileTransfer');
    expect(service).toContain('executeFileTransfer');
    expect(service).toContain('file_exchange_receipts');
    expect(route).toContain("router.post('/inspect'");
    expect(route).toContain("router.post('/execute'");
  });

  it('requires server-recorded confirmation instead of a client confirmed boolean', () => {
    expect(route).toContain("router.post('/confirm'");
    expect(route).not.toContain('confirmed: z.boolean');
    expect(service).toContain('confirmFileTransferPlan');
    expect(service).toContain('confirmed_by_user_id');
    expect(confirmationMigration).toContain('confirmed_at TIMESTAMPTZ');
    expect(tool).toContain('await ctx.askUser');
    expect(tool).toContain('await confirmFileTransferPlan(actor, plan.id)');
  });

  it('returns a prior receipt on retries and never replays an uncertain stale execution', () => {
    expect(service).toContain('findReceiptByPlan(actor, planId)');
    expect(service).toContain("ON CONFLICT (plan_id) DO NOTHING");
    expect(service).toContain('recoverStaleFileTransfer');
    expect(service).toContain("failureCode: 'UNCERTAIN_EXECUTION'");
    expect(service).toContain("INTERVAL '5 minutes'");
  });

  it('revalidates provider authority and source identity at execute time', () => {
    expect(service.match(/resolveFileSource\(actor/g)?.length).toBeGreaterThanOrEqual(2);
    expect(service.match(/assertFileDestination\(actor/g)?.length).toBeGreaterThanOrEqual(2);
    expect(service).toContain('source.version !== plan.source_version');
    expect(service).toContain('hash.digest');
    expect(service).toContain('plan.source_sha256');
  });

  it('uses exclusive destination creation instead of overwrite', () => {
    expect(providers).toContain("fs.open(candidatePath, 'wx'");
    expect(service).not.toContain('copyFile(');
  });

  it('streams source hashing and destination copies without whole-file Buffers', () => {
    expect(providers).toContain('async function digestFile');
    expect(providers).toContain('createReadStream(storagePath)');
    expect(service).toContain('createPersonalBinaryFileFromPath');
    expect(service).toContain('createSessionAttachmentFromPath');
    expect(service).toContain('copyToVerifiedTemp');
    expect(service).toContain('createReadStream(source.storagePath)');
    expect(service).toContain('createWriteStream(tempPath');
    expect(service).toContain('fs.rename(tempPath, reserved.path)');
    expect(service).not.toContain('fs.readFile(source.storagePath)');
  });

  it('records agent principal provenance and binds the tool source to the current Project', () => {
    expect(service).toContain('principal_ref');
    expect(service).toContain('delegated_by_user_id');
    expect(migration).toContain('principal_ref JSONB');
    expect(tool).toContain("source: { scope: 'project', projectId: ctx.projectId!");
    expect(tool).toContain("name: 'deliver_file'");
  });

  it('keeps ACL ownership in providers and forbids host paths in public refs', () => {
    expect(providers).toContain('canAccessRoom');
    expect(providers).toContain('isPathWritableByRole');
    expect(decision).toContain('File Exchange는 ACL의 source of truth가 아니다');
    expect(decision).toContain('host 절대경로');
  });
});
