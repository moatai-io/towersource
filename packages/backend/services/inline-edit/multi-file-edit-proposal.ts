// Owns: short-lived, user-bound confirmation intents for bounded multi-file edits.
// Public API: createMultiFileEditProposal, inspectMultiFileEditProposal,
// reserveMultiFileEditProposal, applyMultiFileEditProposal.
//
// Commit semantics: all target files are locked and stale-checked before any
// replacement. Replacements are staged beside their targets and a failed
// process-visible commit is rolled back. A hard process/host crash during the
// rename phase is not crash-atomic until a durable recovery journal exists.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import lockfile from 'proper-lockfile';
import type { ApprovedRangeReplacement } from './multi-range-edit.js';
import { applyApprovedRanges } from './multi-range-edit.js';
import { ScopedEditError, sourceHash } from './scoped-source-edit.js';

const INTENT_TTL_MS = 10 * 60 * 1000;

type IntentStatus = 'previewed' | 'applying' | 'applied';

interface ProposedFileChange {
  path: string;
  expectedFileHash: string;
  replacements: ApprovedRangeReplacement[];
}

export interface StoredMultiFileIntent {
  version: 1;
  intentId: string;
  proposalHash: string;
  userId: number;
  instruction: string;
  model: string;
  files: ProposedFileChange[];
  createdAt: number;
  expiresAt: number;
  status: IntentStatus;
}

export interface MultiFileEditProposalPreview {
  version: 1;
  intentId: string;
  proposalHash: string;
  expiresAt: string;
  files: Array<{
    path: string;
    ranges: Array<{ start: number; end: number; lineStart: number; lineEnd: number; selector?: string; kind: string }>;
  }>;
}

const intents = new Map<string, StoredMultiFileIntent>();

function pruneIntents(now = Date.now()): void {
  for (const [id, intent] of intents) {
    if (intent.expiresAt <= now) intents.delete(id);
  }
}

function canonicalProposalHash(input: Omit<StoredMultiFileIntent, 'proposalHash' | 'status'>): string {
  return sourceHash(JSON.stringify(input));
}

function publicPreview(intent: StoredMultiFileIntent): MultiFileEditProposalPreview {
  return {
    version: 1,
    intentId: intent.intentId,
    proposalHash: intent.proposalHash,
    expiresAt: new Date(intent.expiresAt).toISOString(),
    files: intent.files.map(file => ({
      path: file.path,
      ranges: file.replacements.map(({ target }) => ({
        start: target.start,
        end: target.end,
        lineStart: target.lineStart,
        lineEnd: target.lineEnd,
        selector: target.selector,
        kind: target.kind,
      })),
    })),
  };
}

export function createMultiFileEditProposal(input: {
  userId: number;
  instruction: string;
  model: string;
  replacements: ApprovedRangeReplacement[];
  currentContents: Map<string, string>;
}): MultiFileEditProposalPreview {
  pruneIntents();
  const paths = [...new Set(input.replacements.map(item => item.target.path))].sort();
  if (paths.length < 2 || paths.length > 8) throw new ScopedEditError('scoped_edit_multifile_targets_invalid', 400);
  const files = paths.map(filePath => {
    const current = input.currentContents.get(filePath);
    if (typeof current !== 'string') throw new ScopedEditError('scoped_edit_multifile_source_missing', 409);
    const replacements = input.replacements.filter(item => item.target.path === filePath);
    // Validate ranges and sources while creating the immutable proposal.
    applyApprovedRanges(current, replacements);
    return { path: filePath, expectedFileHash: sourceHash(current), replacements };
  });
  const base = {
    version: 1 as const,
    intentId: crypto.randomUUID(),
    userId: input.userId,
    instruction: input.instruction.slice(0, 500),
    model: input.model,
    files,
    createdAt: Date.now(),
    expiresAt: Date.now() + INTENT_TTL_MS,
  };
  const intent: StoredMultiFileIntent = { ...base, proposalHash: canonicalProposalHash(base), status: 'previewed' };
  intents.set(intent.intentId, intent);
  return publicPreview(intent);
}

export function inspectMultiFileEditProposal(input: { intentId: string; proposalHash: string; userId: number }): { status: IntentStatus; preview: MultiFileEditProposalPreview } {
  pruneIntents();
  const intent = intents.get(input.intentId);
  if (!intent || intent.userId !== input.userId || intent.proposalHash !== input.proposalHash) {
    throw new ScopedEditError('scoped_edit_multifile_proposal_invalid_or_expired', 409);
  }
  return { status: intent.status, preview: publicPreview(intent) };
}

export function reserveMultiFileEditProposal(input: { intentId: string; proposalHash: string; userId: number }): { intent: StoredMultiFileIntent; release: () => void; complete: () => void } {
  const inspected = inspectMultiFileEditProposal(input);
  const intent = intents.get(input.intentId)!;
  if (inspected.status !== 'previewed') throw new ScopedEditError('scoped_edit_proposal_already_used', 409);
  intent.status = 'applying';
  return {
    intent,
    release: () => { if (intent.status === 'applying') intent.status = 'previewed'; },
    complete: () => { intent.status = 'applied'; },
  };
}

function safeUnlink(filePath: string): void {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* best-effort cleanup */ }
}

export async function applyMultiFileEditProposal(intent: StoredMultiFileIntent): Promise<{ paths: string[] }> {
  const files = [...intent.files].sort((a, b) => a.path.localeCompare(b.path));
  const releases: Array<() => Promise<void>> = [];
  const staged: Array<{ target: string; temp: string; backup: string; committed: boolean }> = [];
  try {
    for (const file of files) {
      releases.push(await lockfile.lock(file.path, { realpath: true, retries: { retries: 3, minTimeout: 25, maxTimeout: 100 } }));
    }
    for (const file of files) {
      const current = fs.readFileSync(file.path, 'utf8');
      if (sourceHash(current) !== file.expectedFileHash) throw new ScopedEditError('scoped_edit_file_stale', 409);
      const next = applyApprovedRanges(current, file.replacements);
      const suffix = `${intent.intentId}.${crypto.randomUUID()}`;
      const temp = path.join(path.dirname(file.path), `.${path.basename(file.path)}.tower-scoped-${suffix}.tmp`);
      const backup = path.join(path.dirname(file.path), `.${path.basename(file.path)}.tower-scoped-${suffix}.bak`);
      const mode = fs.statSync(file.path).mode;
      const fd = fs.openSync(temp, 'wx', mode);
      try { fs.writeFileSync(fd, next, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      staged.push({ target: file.path, temp, backup, committed: false });
    }
    try {
      for (const item of staged) {
        fs.renameSync(item.target, item.backup);
        try {
          fs.renameSync(item.temp, item.target);
          item.committed = true;
        } catch (error) {
          fs.renameSync(item.backup, item.target);
          throw error;
        }
      }
    } catch (error) {
      for (const item of [...staged].reverse()) {
        if (!item.committed) continue;
        safeUnlink(item.target);
        if (fs.existsSync(item.backup)) fs.renameSync(item.backup, item.target);
        item.committed = false;
      }
      throw error;
    }
    for (const item of staged) safeUnlink(item.backup);
    return { paths: files.map(file => file.path) };
  } finally {
    // Never delete a backup from generic cleanup. If rollback itself fails, the
    // .bak file is the remaining recovery evidence and must be preserved.
    for (const item of staged) safeUnlink(item.temp);
    for (const release of releases.reverse()) await release().catch(() => {});
  }
}
