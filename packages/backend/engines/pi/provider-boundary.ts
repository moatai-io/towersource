// Tower Pi execution only uses the central LiteLLM Router or OpenRouter.
// Keep this check at resolution as well as registration: Pi ships built-in
// providers, and an older VM-local models.json can outlive packaged defaults.
export function isAllowedTowerPiProvider(provider: string): boolean {
  return provider === 'litellm-responses' || provider === 'openrouter';
}

export function isAllowedTowerPiModel(spec: string): boolean {
  const slash = spec.indexOf('/');
  return slash > 0 && slash < spec.length - 1 && isAllowedTowerPiProvider(spec.slice(0, slash))
    && spec !== 'litellm-responses/gpt55';
}
