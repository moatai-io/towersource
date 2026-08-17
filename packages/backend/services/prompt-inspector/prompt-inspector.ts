/**
 * Owns: admin-only reconstruction of the system prompt assembled for a Session.
 * Public API: inspectSessionPrompt. See README.md.
 */
import { createHash } from 'node:crypto';
import { getSession } from '../session/session-manager.js';
import { getUserAllowedPath } from '../auth/auth.js';
import { resolveHarnessForSession } from '../harness/harness-resolver.js';
import { buildPiSessionResources, PI_RESPONSE_STYLE_PROMPT } from '../../engines/pi/session-resources.js';
import { buildSystemPrompt } from '../system-prompt.js';
import { resolveSessionProjectRoot } from '../pm/project-access.js';
import { selectSystemPromptFragmentsForMessage } from '../system-prompt-fragments.js';
import { queryOne } from '../../db/pg-repo.js';

export interface PromptInspectorBlock {
  id: string;
  source: string;
  content: string;
  characters: number;
  estimatedTokens: number;
  sha256: string;
}

function block(id: string, source: string, content: string): PromptInspectorBlock {
  return {
    id,
    source,
    content,
    characters: content.length,
    estimatedTokens: Math.ceil(content.length / 4),
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

export function redactSecrets(input: string): string {
  return input
    // PEM bodies are multiline and may not have a nearby key=value label.
    .replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, '[REDACTED PRIVATE KEY]')
    // Preserve JSON/env quoting while replacing the value itself.
    .replace(/(authorization\s*[:=]\s*["']?bearer\s+)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/((?:"?(?:api[_-]?key|token|password|secret|private[_-]?key)"?)\s*[:=]\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/((?:'?(?:api[_-]?key|token|password|secret|private[_-]?key)'?)\s*[:=]\s*)'(?:\\.|[^'\\])*'/gi, "$1'[REDACTED]'")
    .replace(/((?:api[_-]?key|token|password|secret|private[_-]?key)\s*[:=]\s*)[^\s,;}]+/gi, '$1[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, '[REDACTED]');
}

/** Rebuild the current prompt inputs for a Session without asking the model to disclose them. */
export async function inspectSessionPrompt(input: {
  sessionId: string;
  inspectingUserId: number;
  inspectingUsername: string;
}) {
  const session = await getSession(input.sessionId, input.inspectingUserId);
  if (!session) throw new Error('Session not found');

  const engine = session.engine || 'pi';
  const runtimeIdentity = await queryOne<{ user_id: number | null; username: string | null; role: string | null; last_user_text: string | null }>(`
    SELECT s.user_id, u.username, u.role,
      (SELECT m.content::text FROM messages m WHERE m.session_id=s.id AND m.role='user' ORDER BY m.created_at DESC LIMIT 1) AS last_user_text
    FROM sessions s LEFT JOIN users u ON u.id=s.user_id WHERE s.id=$1
  `, [session.id]);
  const runtimeUserId = runtimeIdentity?.user_id || input.inspectingUserId;
  const username = session.lastUserUsername || runtimeIdentity?.username || session.ownerUsername || input.inspectingUsername;
  const runtimeRole = runtimeIdentity?.role || 'member';
  const allowedPath = await getUserAllowedPath(runtimeUserId);
  const fragments = selectSystemPromptFragmentsForMessage(runtimeIdentity?.last_user_text);
  const opts = {
    cwd: session.cwd,
    model: session.modelUsed,
    userId: runtimeUserId,
    username,
    userRole: runtimeRole,
    allowedPath,
    projectId: session.projectId || undefined,
    sessionProjectRoot: resolveSessionProjectRoot(session.cwd) ?? undefined,
    systemPromptFragments: fragments,
  };

  const blocks: PromptInspectorBlock[] = [];
  let exactness: 'runtime-reconstruction' | 'tower-builder-reconstruction' = 'tower-builder-reconstruction';

  if (engine === 'pi') {
    const harness = await resolveHarnessForSession({
      sessionId: session.id,
      requestedEngine: 'pi',
      requestedModel: session.modelUsed,
      projectId: session.projectId || undefined,
      invocationKind: 'session',
    });
    const resources = await buildPiSessionResources({
      sessionId: session.id,
      opts,
      model: { contextWindow: 200_000 },
      projectName: session.projectId || 'unassigned',
      harness,
    });
    const sdkBase = resources.resourceLoader.getSystemPrompt?.() || '';
    if (sdkBase) blocks.push(block('pi-sdk-base', 'Pi DefaultResourceLoader.getSystemPrompt()', redactSecrets(sdkBase)));
    blocks.push(block('pi-response-style', 'Tower PI_RESPONSE_STYLE_PROMPT', redactSecrets(PI_RESPONSE_STYLE_PROMPT)));
    blocks.push(block('tower-system-prompt', 'Tower buildSystemPrompt()', redactSecrets(resources.towerPrompt)));
    if (resources.memoryContext) blocks.push(block('memory-context', 'Tower personal continuity memory', redactSecrets(resources.memoryContext)));
    exactness = 'runtime-reconstruction';
  } else {
    const prompt = await buildSystemPrompt({
      userId: runtimeUserId,
      username,
      role: runtimeRole,
      allowedPath,
      sessionProjectRoot: resolveSessionProjectRoot(session.cwd) ?? undefined,
      projectId: session.projectId || undefined,
      sessionId: session.id,
      optionalFragments: fragments,
    });
    blocks.push(block('tower-system-prompt', 'Tower buildSystemPrompt()', redactSecrets(prompt)));
  }

  const content = blocks.map((item) => item.content).filter(Boolean).join('\n\n');
  console.info(`[PromptInspector] actor=${input.inspectingUsername} session=${session.id} engine=${engine} chars=${content.length} sha256=${createHash('sha256').update(content).digest('hex')}`);
  return {
    session: { id: session.id, name: session.name, engine, model: session.modelUsed || null, cwd: session.cwd },
    generatedAt: new Date().toISOString(),
    exactness,
    caveat: '현재 코드·설정·프로젝트 파일과 마지막 사용자 메시지로 재구성한 스냅샷입니다. 과거 호출 당시의 변경 전 입력은 아닙니다. 비밀값 패턴은 항상 마스킹됩니다.',
    blocks,
    total: block('complete', 'ordered concatenation of displayed blocks', content),
  };
}
