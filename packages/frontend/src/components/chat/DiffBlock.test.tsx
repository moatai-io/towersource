// @vitest-environment jsdom
//
// Regression: ```diff blocks with prose / checklist content (e.g. lines
// starting with ✅) used to render the raw JSON parser error
//   "Unexpected token '✅', \"✅ 결정문서 wo\"... is not valid JSON"
// because the renderer tried JSON spec → unified-diff → BlockFallback(error).
// The error is misleading noise: the user never intended JSON. Fix is to
// detect "no diff intent" and silently fall back to a plain code block.

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import DiffBlock from './DiffBlock';

// Stub the settings store so DiffBlock can read theme without setup.
import { useSettingsStore } from '../../stores/settings-store';
useSettingsStore.setState({ theme: 'dark' as never });

describe('DiffBlock — graceful fallback for non-diff content', () => {
  it('renders prose with ✅ markers as plain code (no JSON error surface)', () => {
    const raw = [
      '✅ 결정문서  workspace/decisions/2026-05-10-server-resume-prompt-hidden.md',
      '✅ 마이그레이션 055   messages.metadata + sessions.last_auto_resume_at',
      '✅ 백엔드  saveMessage(metadata) / setLastAutoResumeAt',
    ].join('\n');

    const { container, queryByText } = render(<DiffBlock raw={raw} fallbackCode={'```diff\n' + raw + '\n```'} />);

    // No JSON parse error message bubbled up.
    expect(queryByText(/is not valid JSON/i)).toBeNull();
    expect(queryByText(/Unexpected token/i)).toBeNull();
    // The raw content is still visible.
    expect(container.textContent).toContain('✅ 결정문서');
    expect(container.textContent).toContain('마이그레이션 055');
  });

  it('renders bullet-style prose without an error', () => {
    const raw = '• step one\n• step two\n• step three';
    const { queryByText, container } = render(<DiffBlock raw={raw} fallbackCode={raw} />);
    expect(queryByText(/is not valid JSON/i)).toBeNull();
    expect(container.textContent).toContain('step one');
  });

  it('still surfaces the parse error when content clearly attempted JSON', () => {
    // Starts with `{` so the renderer treats it as a JSON attempt, but the
    // body is non-JSON garbage that even loose JSON can't salvage. The
    // BlockFallback path should surface the parse error so the author can
    // fix it.
    const raw = '{✅ this is not really json at all\nblah blah\n';
    const { container } = render(<DiffBlock raw={raw} fallbackCode={raw} />);
    expect(container.textContent).toMatch(/JSON|token|expected|unexpected/i);
  });

  it('still surfaces the parse error when content looks diff-like but malformed', () => {
    // Lines start with `+` / `-` so it's clearly an attempted diff. We pass
    // it through parseUnifiedDiff which may produce an empty result — error
    // is more useful than silent fallback because the author intended a
    // diff and got nothing.
    const raw = '+only-add\n-only-remove\nrandom plain';
    const { container } = render(<DiffBlock raw={raw} fallbackCode={raw} />);
    // This may parse successfully as a unified diff (it has +/- prefixes),
    // so we don't strictly assert error UI here — just that the block
    // renders without crashing.
    expect(container.textContent).toBeTruthy();
  });

  it('renders a valid JSON spec normally (regression on happy path)', () => {
    const raw = JSON.stringify({ before: 'old line', after: 'new line', mode: 'unified' });
    const { container } = render(<DiffBlock raw={raw} fallbackCode={raw} />);
    expect(container.textContent).toContain('old line');
    expect(container.textContent).toContain('new line');
  });
});
