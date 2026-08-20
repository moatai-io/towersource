#!/usr/bin/env tsx
import { probeConfiguredInferenceProviders } from '../services/ai/inference-provider-health.js';
import { getInferenceProviderReadiness } from '../services/ai/inference-provider-readiness.js';

const readiness = process.argv.includes('--no-network')
  ? { ...getInferenceProviderReadiness(), checkedProviders: [], failedProviders: [] }
  : await probeConfiguredInferenceProviders(getInferenceProviderReadiness());
const json = process.argv.includes('--json');
if (json) {
  console.log(JSON.stringify(readiness, null, 2));
} else {
  console.log(`Inference provider: ${readiness.status}`);
  console.log(`Default model: ${readiness.defaultModel}`);
  console.log(`Ready providers: ${readiness.readyProviders.join(', ') || '(none)'}`);
  console.log(`Configured providers: ${readiness.configuredProviders.join(', ') || '(none)'}`);
  console.log(`Authenticated providers: ${readiness.checkedProviders.join(', ') || '(not checked)'}`);
  for (const failure of readiness.failedProviders) console.log(`Provider failure: ${failure.provider} — ${failure.reason}`);
  console.log(`Next action: ${readiness.nextAction}`);
}
if (readiness.status !== 'ready') process.exitCode = 1;
