import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { resolveProjectApiKeySecretValue } from '../credential-vault/credential-vault-service.js';

const OUTPUT_DIR = path.resolve(process.cwd(), 'data/generated-agent-characters');
const ID_RE = /^[0-9a-f-]{36}$/i;

/** Returns the local PNG path for an opaque generated character id. */
export function generatedCharacterPath(id: string): string | null {
  return ID_RE.test(id) ? path.join(OUTPUT_DIR, `${id}.png`) : null;
}

export class AgentCharacterGenerationError extends Error {
  constructor(public readonly kind: 'credential_unavailable' | 'provider_rejected' | 'empty_result') {
    super(kind);
    this.name = 'AgentCharacterGenerationError';
  }
}

/** Generates one square Korean agent portrait with the Project's Vault-authorized OpenAI Image credential. */
export async function generateAgentCharacter(opts: { projectId: string; userId: number; prompt: string }): Promise<{ id: string; face: string }> {
  const resolved = await resolveProjectApiKeySecretValue({
    projectId: opts.projectId,
    userId: opts.userId,
    envName: 'OPENAI_IMAGE_API_KEY',
    targetType: 'agent-character-generation',
  });
  if (!resolved) throw new AgentCharacterGenerationError('credential_unavailable');
  const prompt = opts.prompt.trim().slice(0, 800);
  if (!prompt) throw new Error('character prompt required');
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resolved.value}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-image-1',
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
      prompt: `Square head-and-shoulders character portrait for a professional AI teammate card. Korean adult. ${prompt}. Distinct silhouette, hairstyle, clothing color, and one role-relevant prop. Warm polished 3D editorial illustration, clean soft background, centered face, no text, no letters, no logo, no watermark.`,
    }),
  });
  const payload = await response.json() as { data?: Array<{ b64_json?: string }> };
  if (!response.ok) throw new AgentCharacterGenerationError('provider_rejected');
  const encoded = payload.data?.[0]?.b64_json;
  if (!encoded) throw new AgentCharacterGenerationError('empty_result');
  const id = randomUUID();
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUTPUT_DIR, `${id}.png`), Buffer.from(encoded, 'base64'), { mode: 0o640 });
  return { id, face: `generated:${id}` };
}
