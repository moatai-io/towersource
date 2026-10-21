import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SessionLinkNotice } from './SessionLinkNotice';
import type { SessionLinkState } from '../../hooks/session-link-resolution';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('SessionLinkNotice', () => {
  it.each([
    ['forbidden', 'sessionAccessDeniedTitle'], ['not_found', 'requestedSessionNotFoundTitle'],
    ['authentication_required', 'sessionAuthenticationRequiredTitle'], ['unavailable', 'sessionUnavailableTitle'],
    ['archived', 'sessionArchivedLinkTitle'], ['loading', 'sessionLinkLoadingTitle'],
  ] as const)('shows the distinct %s reason in the main surface', (kind, title) => {
    const html = renderToStaticMarkup(<SessionLinkNotice state={{ kind } as SessionLinkState} onOpenArchive={() => {}} />);
    expect(html).toContain(title);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('iframe');
    if (kind !== 'loading') expect(html).toContain('href="/"');
    if (kind === 'archived') expect(html).toContain('archivedSessionsTitle');
  });
});
