// Public API for the inline-edit module.
//
// Consumers (routes/api.ts) should import only from this file — never reach
// into prompt.ts / edit-engine.ts / audit.ts directly. Keeping the surface
// narrow lets us refactor internals (e.g. swap the utility-agent for a
// streaming variant) without touching callers.

export { runInlineEdit, DEFAULT_INLINE_EDIT_MODEL, LIMITS } from './edit-engine.js';
export type { InlineEditRequest, InlineEditResult } from './edit-engine.js';
export { appendInlineEditAudit } from './audit.js';
export type { InlineEditAuditEntry } from './audit.js';
