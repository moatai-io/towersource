const PATCH_CONTROL_FIELDS = new Set(['enabled']);

export interface AutomationPatchClassification {
  allowed: boolean;
  controlUpdates: Record<string, unknown>;
  configFields: string[];
  unknownFields: string[];
}

export function classifyAutomationPatch(body: unknown): AutomationPatchClassification {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { allowed: false, controlUpdates: {}, configFields: [], unknownFields: [] };
  }
  const entries = Object.entries(body as Record<string, unknown>);
  const controlUpdates: Record<string, unknown> = {};
  const configFields: string[] = [];
  const unknownFields: string[] = [];

  for (const [key, value] of entries) {
    if (PATCH_CONTROL_FIELDS.has(key)) {
      controlUpdates[key] = value;
      continue;
    }
    if (key === 'confirmedHighRisk' || key === 'riskLevel') {
      unknownFields.push(key);
      continue;
    }
    configFields.push(key);
  }

  const enabledValid = controlUpdates.enabled === undefined || typeof controlUpdates.enabled === 'boolean';
  return {
    allowed: entries.length > 0 && configFields.length === 0 && unknownFields.length === 0 && enabledValid,
    controlUpdates,
    configFields,
    unknownFields,
  };
}
