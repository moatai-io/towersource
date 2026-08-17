import { runUtilityTextTask } from './ai/utility-agent.js';
import { resolveLanguage } from './language-resolver.js';
import { getModelDefaults } from '../config.js';

/**
 * Generate a session name using an engine-neutral utility agent.
 *
 * Titles are emitted in the workspace default language — fixes the common
 * drift where Korean conversations got English session titles.
 */
export async function generateSessionName(
  firstUserMessage: string,
  firstAssistantResponse: string,
): Promise<string> {
  const snippet = firstAssistantResponse.slice(0, 500);
  const prompt = `Generate a clear conversation title for this conversation. Make it specific enough to find again later. Prefer 12-28 Korean characters for Korean conversations, or 4-8 words for English. Output only one line, no quotes, no extra explanation.\n\nUser: ${firstUserMessage}\nAssistant: ${snippet}\n\nTitle:`;

  const lang = resolveLanguage();
  const langPrefix = languagePrefix(lang);

  const resultText = await runUtilityTextTask({
    prompt,
    model: getModelDefaults().ai_reply,
    systemPrompt: `${langPrefix}You are a conversation title generator. Create a clear, specific title that helps users find the session later. Do not over-compress it. Prefer 12-28 Korean characters for Korean conversations, or 4-8 words for English. Output only one line, no quotes, no extra explanation. Do not use any tools.`,
    fallbackText: firstUserMessage.slice(0, 20),
  });

  const cleaned = resultText
    .split('\n')[0]
    .replace(/^["'「」『』]+|["'「」『』]+$/g, '')
    .trim();

  return cleaned || firstUserMessage.slice(0, 20);
}

function languagePrefix(code: string): string {
  switch (code) {
    case 'ko': return '한국어 제목으로 답하십시오. ';
    case 'ja': return '日本語のタイトルで回答してください。 ';
    case 'zh': return '请用中文生成标题。 ';
    case 'en': return 'Respond with an English title. ';
    default:   return `Respond with a title in ${code}. `;
  }
}
