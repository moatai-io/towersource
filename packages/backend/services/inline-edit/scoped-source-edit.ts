// Owns: signed, stale-safe source-range edit proposals.
// Public API: createScopedEditProposal, verifyScopedEditProposal, applyScopedReplacement.

import crypto, { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../../config.js';

const PROPOSAL_AUDIENCE = 'scoped-source-edit';
const PROPOSAL_ISSUER = 'tower';
const PROPOSAL_TTL = '10m';

export interface ScopedEditSelection {
  path: string;
  start: number;
  end: number;
  expectedSource: string;
}

export interface ScopedEditProposalPayload {
  version: 1;
  userId: number;
  path: string;
  start: number;
  end: number;
  expectedFileHash: string;
  expectedSourceHash: string;
  replacement: string;
  instruction: string;
  model: string;
  proposalId: string;
}

export interface ScopedEditProposal extends ScopedEditProposalPayload {
  proposalToken: string;
}

export class ScopedEditError extends Error {
  constructor(public code: string, public status: number, message = code) {
    super(message);
    this.name = 'ScopedEditError';
  }
}

export function sourceHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function validateScopedSelection(currentContent: string, selection: ScopedEditSelection): void {
  if (!Number.isInteger(selection.start) || !Number.isInteger(selection.end)
    || selection.start < 0 || selection.end <= selection.start || selection.end > currentContent.length) {
    throw new ScopedEditError('scoped_edit_invalid_range', 400);
  }
  if (currentContent.slice(selection.start, selection.end) !== selection.expectedSource) {
    throw new ScopedEditError('scoped_edit_selection_stale', 409);
  }
}

export function createScopedEditProposal(input: {
  userId: number;
  selection: ScopedEditSelection;
  currentContent: string;
  replacement: string;
  instruction: string;
  model: string;
}): ScopedEditProposal {
  validateScopedSelection(input.currentContent, input.selection);
  if (input.replacement.length > 20_000) {
    throw new ScopedEditError('scoped_edit_replacement_too_large', 400);
  }
  const payload: ScopedEditProposalPayload = {
    version: 1,
    userId: input.userId,
    path: input.selection.path,
    start: input.selection.start,
    end: input.selection.end,
    expectedFileHash: sourceHash(input.currentContent),
    expectedSourceHash: sourceHash(input.selection.expectedSource),
    replacement: input.replacement,
    instruction: input.instruction.slice(0, 500),
    model: input.model,
    proposalId: crypto.randomUUID(),
  };
  const proposalToken = jwt.sign(payload, config.jwtSecret, {
    audience: PROPOSAL_AUDIENCE,
    issuer: PROPOSAL_ISSUER,
    expiresIn: PROPOSAL_TTL,
  });
  return { ...payload, proposalToken };
}

export function verifyScopedEditProposal(proposalToken: string, userId: number): ScopedEditProposalPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(proposalToken, config.jwtSecret, {
      audience: PROPOSAL_AUDIENCE,
      issuer: PROPOSAL_ISSUER,
    });
  } catch {
    throw new ScopedEditError('scoped_edit_proposal_invalid_or_expired', 409);
  }
  const value = decoded as Partial<ScopedEditProposalPayload>;
  if (value.version !== 1 || value.userId !== userId || typeof value.path !== 'string'
    || !Number.isInteger(value.start) || !Number.isInteger(value.end)
    || typeof value.expectedFileHash !== 'string' || typeof value.expectedSourceHash !== 'string'
    || typeof value.replacement !== 'string' || typeof value.instruction !== 'string'
    || typeof value.model !== 'string' || typeof value.proposalId !== 'string') {
    throw new ScopedEditError('scoped_edit_proposal_invalid_or_expired', 409);
  }
  return value as ScopedEditProposalPayload;
}

export function applyScopedReplacement(currentContent: string, proposal: ScopedEditProposalPayload): string {
  if (sourceHash(currentContent) !== proposal.expectedFileHash) {
    throw new ScopedEditError('scoped_edit_file_stale', 409);
  }
  if (proposal.start < 0 || proposal.end <= proposal.start || proposal.end > currentContent.length) {
    throw new ScopedEditError('scoped_edit_invalid_range', 409);
  }
  const selected = currentContent.slice(proposal.start, proposal.end);
  if (sourceHash(selected) !== proposal.expectedSourceHash) {
    throw new ScopedEditError('scoped_edit_selection_stale', 409);
  }
  return currentContent.slice(0, proposal.start) + proposal.replacement + currentContent.slice(proposal.end);
}
