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
export {
  ScopedEditError,
  applyScopedReplacement,
  createScopedEditProposal,
  sourceHash,
  validateScopedSelection,
  verifyScopedEditProposal,
} from './scoped-source-edit.js';
export type {
  ScopedEditProposal,
  ScopedEditProposalPayload,
  ScopedEditSelection,
} from './scoped-source-edit.js';
export { discoverStaticHtmlCssEditPlan, remapHtmlElementByUniqueId } from './html-css-edit-plan.js';
export type {
  HtmlCssPlanWarning,
  HtmlCssSourceRange,
  RemappedHtmlElementRange,
  StaticHtmlCssEditPlan,
} from './html-css-edit-plan.js';
export { applyApprovedRanges, generateApprovedRangeReplacements } from './multi-range-edit.js';
export type { ApprovedRangeReplacement } from './multi-range-edit.js';
export {
  applyMultiFileEditProposal,
  createMultiFileEditProposal,
  inspectMultiFileEditProposal,
  reserveMultiFileEditProposal,
} from './multi-file-edit-proposal.js';
export type { MultiFileEditProposalPreview } from './multi-file-edit-proposal.js';
