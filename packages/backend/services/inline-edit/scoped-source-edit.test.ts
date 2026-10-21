import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', () => ({ config: { jwtSecret: 'test-scoped-edit-secret' } }));

import {
  ScopedEditError,
  applyScopedReplacement,
  createScopedEditProposal,
  sourceHash,
  validateScopedSelection,
  verifyScopedEditProposal,
} from './scoped-source-edit.js';

const content = '<main><button>Buy</button><p>Keep</p></main>';
const selected = '<button>Buy</button>';
const start = content.indexOf(selected);
const end = start + selected.length;

describe('scoped source edit proposal', () => {
  it('creates a user-bound proposal and changes only the selected range', () => {
    const proposal = createScopedEditProposal({
      userId: 7,
      selection: { path: '/workspace/project/index.html', start, end, expectedSource: selected },
      currentContent: content,
      replacement: '<button>Start</button>',
      instruction: 'Shorten the CTA',
      model: 'test-model',
    });
    const verified = verifyScopedEditProposal(proposal.proposalToken, 7);
    const next = applyScopedReplacement(content, verified);

    expect(next).toBe('<main><button>Start</button><p>Keep</p></main>');
    expect(next.slice(0, start)).toBe(content.slice(0, start));
    expect(next.slice(start + verified.replacement.length)).toBe(content.slice(end));
  });

  it('rejects a proposal under another user identity', () => {
    const proposal = createScopedEditProposal({
      userId: 7,
      selection: { path: '/workspace/project/index.html', start, end, expectedSource: selected },
      currentContent: content,
      replacement: '<button>Start</button>',
      instruction: 'Shorten',
      model: 'test-model',
    });
    expect(() => verifyScopedEditProposal(proposal.proposalToken, 8)).toThrowError(ScopedEditError);
  });

  it('rejects stale source before a proposal can be issued', () => {
    expect(() => validateScopedSelection(content, {
      path: '/workspace/project/index.html', start, end, expectedSource: '<button>Changed</button>',
    })).toThrowError(expect.objectContaining({ code: 'scoped_edit_selection_stale', status: 409 }));
  });

  it('rejects apply when any part of the file changed after proposal', () => {
    const proposal = createScopedEditProposal({
      userId: 7,
      selection: { path: '/workspace/project/index.html', start, end, expectedSource: selected },
      currentContent: content,
      replacement: '<button>Start</button>',
      instruction: 'Shorten',
      model: 'test-model',
    });
    const verified = verifyScopedEditProposal(proposal.proposalToken, 7);

    expect(() => applyScopedReplacement(content.replace('Keep', 'Changed'), verified))
      .toThrowError(expect.objectContaining({ code: 'scoped_edit_file_stale', status: 409 }));
  });

  it('uses SHA-256 content hashes', () => {
    expect(sourceHash('abc')).toMatch(/^[a-f0-9]{64}$/);
  });
});
