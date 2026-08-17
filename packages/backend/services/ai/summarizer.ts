import { runUtilityTextTask } from './utility-agent.js';
import { resolveLanguage } from '../language-resolver.js';
import { getModelDefaults } from '../../config.js';

/**
 * Generate a session summary using an engine-neutral utility agent.
 *
 * Summaries are written in the workspace default language (resolveLanguage
 * with no user/session context falls through to WORKSPACE_LANGUAGE env → 'ko').
 * Session titles and summaries should match the user's language — writing
 * Korean conversations' summaries in English was a common drift symptom.
 */
export async function generateSummary(messagesText: string): Promise<string> {
  const prompt = `Below is a conversation history. Summarize it in this format:

1) Topic flow in one line using arrows (→)
2) Key actions/tasks as 3-5 bullet points (•)
3) Current status in one line

Example:
Model selector → DB migration → Frontend integration
• Added model switching via SDK Options.model
• Implemented auto session naming service
• Created SummaryCard component
Status: Build succeeded, testing on server

---
${messagesText}
---

Summary of the above conversation:`;

  const lang = resolveLanguage();
  const langPrefix = languagePrefix(lang);

  const resultText = await runUtilityTextTask({
    prompt,
    model: getModelDefaults().ai_reply,
    systemPrompt: `${langPrefix}You are a conversation summarizer. Do not greet. Do not use any tools. Output only in the specified format (arrow flow + bullet points + current status).`,
    fallbackText: 'Summary generation failed',
  });

  return resultText.trim() || 'Summary generation failed';
}

function languagePrefix(code: string): string {
  switch (code) {
    case 'ko': return '한국어로 답하십시오. ';
    case 'ja': return '日本語で回答してください。 ';
    case 'zh': return '请用中文回答。 ';
    case 'en': return 'Respond in English. ';
    default:   return `Respond in ${code}. `;
  }
}
