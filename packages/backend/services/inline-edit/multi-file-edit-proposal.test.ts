import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovedRangeReplacement } from './multi-range-edit.js';
import { applyMultiFileEditProposal, createMultiFileEditProposal, inspectMultiFileEditProposal, reserveMultiFileEditProposal } from './multi-file-edit-proposal.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-multifile-'));
  roots.push(root);
  const htmlPath = path.join(root, 'index.html');
  const cssPath = path.join(root, 'styles.css');
  const html = '<button class="cta">Start</button>\n';
  const css = '.cta { color: gray; }\n';
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(cssPath, css);
  const replacements: ApprovedRangeReplacement[] = [
    { target: { path: htmlPath, kind: 'html-element', start: 0, end: html.trimEnd().length, lineStart: 1, lineEnd: 1, source: html.trimEnd() }, replacement: '<button class="cta primary">Start</button>' },
    { target: { path: cssPath, kind: 'css-rule', start: 0, end: css.trimEnd().length, lineStart: 1, lineEnd: 1, source: css.trimEnd(), selector: '.cta' }, replacement: '.cta { color: blue; }' },
  ];
  return { htmlPath, cssPath, html, css, replacements };
}

describe('multi-file scoped edit proposals', () => {
  it('binds preview to the user and proposal hash and enforces single-use reservation', () => {
    const f = fixture();
    const preview = createMultiFileEditProposal({ userId: 7, instruction: 'make primary', model: 'test', replacements: f.replacements, currentContents: new Map([[f.htmlPath, f.html], [f.cssPath, f.css]]) });
    expect(preview.files).toHaveLength(2);
    expect(() => inspectMultiFileEditProposal({ intentId: preview.intentId, proposalHash: preview.proposalHash, userId: 8 })).toThrow('scoped_edit_multifile_proposal_invalid_or_expired');
    const reservation = reserveMultiFileEditProposal({ intentId: preview.intentId, proposalHash: preview.proposalHash, userId: 7 });
    expect(() => reserveMultiFileEditProposal({ intentId: preview.intentId, proposalHash: preview.proposalHash, userId: 7 })).toThrow('scoped_edit_proposal_already_used');
    reservation.complete();
  });

  it('locks, stale-checks, and applies all proposed files', async () => {
    const f = fixture();
    const preview = createMultiFileEditProposal({ userId: 7, instruction: 'make primary', model: 'test', replacements: f.replacements, currentContents: new Map([[f.htmlPath, f.html], [f.cssPath, f.css]]) });
    const reservation = reserveMultiFileEditProposal({ intentId: preview.intentId, proposalHash: preview.proposalHash, userId: 7 });
    await applyMultiFileEditProposal(reservation.intent);
    reservation.complete();
    expect(fs.readFileSync(f.htmlPath, 'utf8')).toContain('cta primary');
    expect(fs.readFileSync(f.cssPath, 'utf8')).toContain('color: blue');
  });

  it('rejects the full transaction before writes when any file is stale', async () => {
    const f = fixture();
    const preview = createMultiFileEditProposal({ userId: 7, instruction: 'make primary', model: 'test', replacements: f.replacements, currentContents: new Map([[f.htmlPath, f.html], [f.cssPath, f.css]]) });
    fs.writeFileSync(f.cssPath, '.cta { color: red; }\n');
    const reservation = reserveMultiFileEditProposal({ intentId: preview.intentId, proposalHash: preview.proposalHash, userId: 7 });
    await expect(applyMultiFileEditProposal(reservation.intent)).rejects.toThrow('scoped_edit_file_stale');
    reservation.release();
    expect(fs.readFileSync(f.htmlPath, 'utf8')).toBe(f.html);
  });

  it('rolls back an earlier committed file when a later replacement fails', async () => {
    const f = fixture();
    const preview = createMultiFileEditProposal({ userId: 7, instruction: 'make primary', model: 'test', replacements: f.replacements, currentContents: new Map([[f.htmlPath, f.html], [f.cssPath, f.css]]) });
    const reservation = reserveMultiFileEditProposal({ intentId: preview.intentId, proposalHash: preview.proposalHash, userId: 7 });
    const originalRename = fs.renameSync.bind(fs);
    let tempToTargetRenames = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).endsWith('.tmp') && !String(to).endsWith('.bak')) {
        tempToTargetRenames += 1;
        if (tempToTargetRenames === 2) throw new Error('injected commit failure');
      }
      return originalRename(from, to);
    });
    await expect(applyMultiFileEditProposal(reservation.intent)).rejects.toThrow('injected commit failure');
    reservation.release();
    expect(fs.readFileSync(f.htmlPath, 'utf8')).toBe(f.html);
    expect(fs.readFileSync(f.cssPath, 'utf8')).toBe(f.css);
  });
});
