// Provider-only projections. Never modify canonical images/history.
// HTTP bytes and vision tokens are separate budgets: Base64 is not text input.
export const DEFAULT_PI_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
export const PI_IMAGE_TOKEN_ESTIMATE = 1600; // SDK-style coarse hint, not provider billing.

function isInlineImage(value: any): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.type === 'image_url') return true;
  if (value.type === 'input_image') return true;
  if (value.type === 'image') return true;
  return false;
}

export function estimateProviderInput(value: unknown): {
  estimatedTokens: number; textTokens: number; imageItems: number; imageTokens: number;
} {
  let imageItems = 0;
  const projected = JSON.stringify(value, (_key, item) => {
    if (!isInlineImage(item)) return item;
    imageItems++;
    // Preserve image identity semantically in history, not transport Base64 in the estimator.
    return { type: 'image_token_hint' };
  }) || '';
  let textTokens = 0;
  for (const character of projected) textTokens += (character.codePointAt(0) || 0) > 0x7f ? 1 : 0.25;
  textTokens = Math.ceil(textTokens);
  const imageTokens = imageItems * PI_IMAGE_TOKEN_ESTIMATE;
  return { estimatedTokens: textTokens + imageTokens, textTokens, imageItems, imageTokens };
}

export function configuredPiRequestBodyLimit(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.PI_PROVIDER_MAX_REQUEST_BODY_BYTES);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_PI_REQUEST_BODY_BYTES;
}

export function inspectProviderRequestBody(body: string, maxBytes = configuredPiRequestBodyLimit()) {
  const requestBytes = Buffer.byteLength(body, 'utf8');
  return { requestBytes, maxBytes, rejected: requestBytes > maxBytes };
}
