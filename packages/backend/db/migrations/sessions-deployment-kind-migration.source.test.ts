import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/149_sessions_deployment_kind.sql'), 'utf8');
const runtime = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/ai-service/ai-service-preview-runtime.ts'), 'utf8');
const sessionManager = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/session/session-manager.ts'), 'utf8');

describe('deployment Session classification', () => {
  it('indexes externally deployed conversations as deployment Sessions', () => {
    expect(migration).toContain("WHERE kind = 'deployment'");
    expect(runtime).toContain("isDeploymentSession ? '배포 세션' : 'ai_service_preview'");
    expect(runtime).toContain("updateSession(session.id, { kind: 'deployment' })");
    expect(sessionManager).toContain("row.kind === 'deployment' ? 'deployment'");
  });

  it('persists deployment Session transcripts through the normal message store', () => {
    expect(runtime).toContain("const isDeploymentSession = input.runtimeMode === 'channel'");
    expect(runtime).toContain("metadata: { aiServiceConversationId: input.conversationId, aiServiceId: input.serviceId, sourceType: input.runtimeMode === 'channel' ? 'ai_service_channel' : 'ai_service_preview' }");
    expect(runtime).toContain('await saveMessage(sessionId');
    expect(runtime).toContain('await updateMessageContent(msgId, content)');
    expect(runtime).toContain('await updateMessageMetrics(msgId');
  });
});
