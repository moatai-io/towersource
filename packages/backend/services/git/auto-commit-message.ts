/**
 * Auto-commit message generation — one-line summary via Tower utility agent.
 *
 * Why: auto-commits all looked identical (`auto: [user] task completed`),
 * making `git log` useless as an audit trail. This function asks the configured
 * utility model for a short Korean commit-message line based on the session's first user prompt
 * and the list of edited files, so history becomes greppable.
 *
 * Fail-safe: ANY error / timeout / empty output → returns the original
 * fallback message. Never blocks or breaks the commit.
 *
 * See workspace/decisions/2026-04-24-auto-commit-audit-trail.md
 */

import path from 'node:path';
import { getModelDefaults } from '../../config.js';
import { getMessages } from '../message-store.js';
import { extractTextFromContent } from '../../utils/text.js';
import { runUtilityTextTask } from '../ai/utility-agent.js';

// Utility calls run after the user's answer is already streamed, so this does
// not block the UX. Keep a generous default for cold starts / provider latency.
// Tunable via env.
const TIMEOUT_MS = Number(process.env.GIT_AUTO_COMMIT_AI_TIMEOUT_MS ?? 60000);
const MAX_PROMPT_CHARS = 400;
const MAX_FILES_IN_PROMPT = 8;
const MAX_LINE_CHARS = 120;

/**
 * Fallback commit subject when utility message generation is unavailable
 * (timeout, error, opt-out, empty session, oversized output).
 *
 * Old behavior: every fallback collapsed to `auto: [user] Claude task completed`,
 * which made up ~46% of `git log` and was useless for grep/audit.
 *
 * New behavior: list the first 3 edited file basenames so the commit is at
 * least topically greppable even without AI. The full file set is still in
 * `git show`'s diff — this is just to make `git log --oneline` skim-friendly.
 *
 * See workspace/decisions/2026-05-07-git-auto-commit-policy.md
 */
function fallback(username: string, editedFiles?: string[]): string {
  if (!editedFiles || editedFiles.length === 0) {
    return `auto: [${username}] task completed`;
  }
  const names = editedFiles.slice(0, 3).map((f) => path.basename(f));
  const more = editedFiles.length > 3 ? ` 외 ${editedFiles.length - 3}개` : '';
  return `auto: [${username}] ${names.join(', ')}${more}`;
}

/**
 * Generate a human-friendly auto-commit message.
 * Returns the fallback string on any failure path.
 */
export async function generateAutoCommitMessage(
  username: string,
  sessionId: string,
  editedFiles: string[],
): Promise<string> {
  // Opt-out switch — set GIT_AUTO_COMMIT_AI_MESSAGE=false to skip the utility call.
  if ((process.env.GIT_AUTO_COMMIT_AI_MESSAGE ?? 'true') === 'false') {
    return fallback(username, editedFiles);
  }
  if (editedFiles.length === 0) return fallback(username, editedFiles);

  try {
    // ── 1. Pull the first user message as task context ──
    const messages = await getMessages(sessionId);
    const firstUser = messages.find((m) => m.role === 'user');
    if (!firstUser) return fallback(username, editedFiles);

    // extractTextFromContent handles both plain strings and JSON-serialized
    // content-block arrays (message-store stores a JSON string either way).
    const rawText = extractTextFromContent(firstUser.content);
    const prompt = rawText.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return fallback(username, editedFiles);

    // ── 2. Build a compact utility-model instruction ──
    const fileList = editedFiles.slice(0, MAX_FILES_IN_PROMPT).join(', ');
    const moreFiles = editedFiles.length > MAX_FILES_IN_PROMPT ? ` 외 ${editedFiles.length - MAX_FILES_IN_PROMPT}개` : '';
    const userInput = `사용자 요청: ${prompt}\n변경 파일 ${editedFiles.length}개: ${fileList}${moreFiles}\n\n위 작업을 요약한 한국어 git 커밋 메시지 한 줄만 답하세요.`;
    const systemPrompt = [
      '너는 git 커밋 메시지를 쓰는 도우미다. 정확히 한 줄만 답한다.',
      '규칙:',
      '- 한국어. 60자 이내.',
      '- conventional commits 접두어(feat/fix/docs/chore/refactor/style)가 명확하면 붙인다. 애매하면 생략.',
      '- 따옴표, 백틱, 코드펜스, 마크다운, 이모지, 개행 금지.',
      '- "요약:" 같은 레이블 금지. 메시지 본문만.',
      '- "작업 완료" 같이 내용 없는 표현 금지. 무엇을 왜 했는지 구체적으로.',
    ].join('\n');

    // ── 3. Engine-neutral utility call, then sanitize to a safe one-liner ──
    const full = await runUtilityTextTask({
      prompt: userInput,
      systemPrompt,
      model: getModelDefaults().ai_reply,
      fallbackText: '',
      timeoutMs: TIMEOUT_MS,
    });

    const line = full
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? '';
    const cleaned = line
      .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '') // strip wrapping quotes
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned || cleaned.length > MAX_LINE_CHARS) return fallback(username, editedFiles);
    return `auto: [${username}] ${cleaned} (${editedFiles.length} files)`;
  } catch (err) {
    console.warn('[auto-commit] AI message generation failed, using fallback:', err);
    return fallback(username, editedFiles);
  }
}
