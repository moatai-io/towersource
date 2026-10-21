import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { resolveGatewayApiClient } from '../gateway-profile/gateway-profile-client.js';

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

/** Generates one square Korean agent portrait through the Project-authorized OpenAI Image Gateway route. */
export async function generateAgentCharacter(opts: { projectId: string; userId: number; prompt: string }): Promise<{ id: string; face: string }> {
  let gateway;
  try {
    gateway = await resolveGatewayApiClient({
      actorUserId: opts.userId,
      projectId: opts.projectId,
      apiId: 'openai-image',
    });
  } catch {
    throw new AgentCharacterGenerationError('credential_unavailable');
  }
  const prompt = opts.prompt.trim().slice(0, 800);
  if (!prompt) throw new Error('character prompt required');
  const response = await fetch(`${gateway.baseUrl}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gateway.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-image-2.5-sunburst',
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
