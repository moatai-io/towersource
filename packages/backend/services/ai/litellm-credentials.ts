/** Server-only VM inference credentials. Never use a personal/project override. */
import { loadModelsFile } from '../../config.js';
import { getSecret } from '../secret/secret-store.js';

export async function resolveLiteLLMCredentials(): Promise<{ baseUrl: string; apiKey: string }> {
  const providers = loadModelsFile().inferenceProviders;
  const saved = providers?.['litellm-responses'] ?? providers?.litellm;
  let baseUrl: string;
  let apiKey: string;
  if (saved) {
    // An explicit VM binding wins over legacy env. Failure must not charge a
    // different account by silently falling back to an old shared key.
    try {
      baseUrl = saved.baseUrl;
      apiKey = await getSecret(saved.secretName, 0);
    } catch {
      throw new Error('LiteLLM VM credential is unavailable');
    }
  } else {
    baseUrl = process.env.LITELLM_BASE_URL || '';
    apiKey = process.env.LITELLM_API_KEY || '';
  }
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    if (!apiKey.trim()) throw new Error();
  } catch {
    throw new Error('LiteLLM VM connection is not configured');
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}
