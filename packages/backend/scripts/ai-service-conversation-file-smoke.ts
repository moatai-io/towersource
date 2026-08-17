/**
 * Smoke test for Conversation-scoped AI Service uploads.
 *
 * Creates an isolated credential-style Conversation on an existing evaluated Channel,
 * saves one TXT file, verifies resume/list/search/read, then deletes the file bytes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { initPg, closePgPool } from '../db/pg.js';
import { query, queryOne } from '../db/pg-repo.js';
import { createAIServiceChannelConversation } from '../services/ai-service/ai-service-channel-runtime.js';
import { conversationFilesSnapshot, deleteConversationFile, listConversationFiles, saveConversationFile } from '../services/ai-service/conversation-files.js';
import { issueConversationResumeGrant, resumeConversation } from '../services/ai-service/conversation-resume.js';
import { readSnapshotKnowledge, searchSnapshotKnowledge } from '../services/ai-service/snapshot-knowledge.js';

interface CandidateRow { service_id: string; channel_id: string; service_name: string }

async function main() {
  await initPg();
  const candidate = (await query<CandidateRow>(`SELECT s.id AS service_id,c.id AS channel_id,s.name AS service_name
    FROM ai_services s JOIN ai_service_channels c ON c.service_id=s.id
    JOIN ai_service_deployments d ON d.id=s.current_deployment_id AND d.service_id=s.id
    WHERE s.status='active' AND c.status='enabled' AND c.active_deployment_id=s.current_deployment_id AND d.status='active'
      AND EXISTS (SELECT 1 FROM ai_service_runtime_evaluations e WHERE e.deployment_id=d.id AND e.status='passed')
    ORDER BY s.updated_at DESC LIMIT 1`))[0];
  if (!candidate) {
    console.log(JSON.stringify({ ok: false, skipped: true, reason: 'no evaluated active AI Service Channel found' }, null, 2));
    return;
  }

  const nonce = crypto.randomBytes(8).toString('hex');
  const tenantKey = `conversation-file-smoke:${nonce}`;
  const userKey = 'conversation-file-smoke';
  const conversation = await createAIServiceChannelConversation({ serviceId: candidate.service_id, channelId: candidate.channel_id, tenantKey, userKey });
  const grant = await issueConversationResumeGrant({ conversationId: conversation.id, serviceId: candidate.service_id, channelId: candidate.channel_id, tenantKey, userKey, ttlDays: 1 });
  const resumed = await resumeConversation({ conversationId: conversation.id, channelId: candidate.channel_id, tenantKey, userKey, resumeToken: grant.resumeToken });
  if (resumed.id !== conversation.id) throw new Error('resume grant did not restore the smoke Conversation');

  const stagingDir = path.join(config.dataDir, 'upload-staging', 'ai-service-conversation-file-smoke');
  await fs.mkdir(stagingDir, { recursive: true });
  const stagedPath = path.join(stagingDir, `${nonce}.txt`);
  const marker = `tower-conversation-file-smoke-${nonce}`;
  const content = `고객 업로드 자료 검증\n고유 표식: ${marker}\n이 문장은 Conversation Knowledge 검색 대상입니다.\n`;
  await fs.writeFile(stagedPath, content, { flag: 'wx', mode: 0o600 });

  let fileId = '';
  try {
    const saved = await saveConversationFile({ conversationId: conversation.id, channelId: candidate.channel_id, tenantKey, userKey, stagedPath, originalName: `smoke-${nonce}.txt`, mimeType: 'text/plain', sizeBytes: Buffer.byteLength(content) });
    fileId = saved.id;
    const listed = await listConversationFiles({ conversationId: conversation.id, channelId: candidate.channel_id, tenantKey, userKey });
    if (!listed.some((file) => file.id === saved.id && file.status === 'ready')) throw new Error('saved file was not listed as ready');

    const snapshot = await conversationFilesSnapshot(conversation.id);
    const results = searchSnapshotKnowledge(snapshot, { query: marker });
    if (!results[0]) throw new Error('Conversation Knowledge search did not find the smoke marker');
    const read = readSnapshotKnowledge(snapshot, { documentId: results[0].documentId, lineStart: results[0].lineStart, lineEnd: results[0].lineEnd });
    if (!read.content.includes(marker)) throw new Error('Conversation Knowledge read did not return the smoke marker');

    await deleteConversationFile({ fileId: saved.id, conversationId: conversation.id, channelId: candidate.channel_id, tenantKey, userKey });
    const deleted = await queryOne<{ processing_status: string; deleted_at: string | null }>('SELECT processing_status,deleted_at FROM ai_service_conversation_files WHERE id=$1', [saved.id]);
    if (deleted?.processing_status !== 'deleted' || !deleted.deleted_at) throw new Error('Conversation file deletion was not recorded');
    const afterSnapshot = await conversationFilesSnapshot(conversation.id);
    if (afterSnapshot) throw new Error('deleted Conversation file remained searchable');

    console.log(JSON.stringify({ ok: true, serviceId: candidate.service_id, serviceName: candidate.service_name, channelId: candidate.channel_id, conversationId: conversation.id, fileId: saved.id, resumeVerified: true, listVerified: true, searchVerified: true, readVerified: true, deleteVerified: true }, null, 2));
  } finally {
    await fs.rm(stagedPath, { force: true });
    if (fileId) {
      const row = await queryOne<{ processing_status: string }>('SELECT processing_status FROM ai_service_conversation_files WHERE id=$1', [fileId]);
      if (row && row.processing_status !== 'deleted') await deleteConversationFile({ fileId, conversationId: conversation.id, channelId: candidate.channel_id, tenantKey, userKey }).catch(() => undefined);
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}).finally(async () => {
  await closePgPool().catch(() => {});
});
