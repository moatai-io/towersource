// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AttachmentChip } from './AttachmentChip';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../stores/session-store', () => ({ useSessionStore: (selector: any) => selector({ activeSessionId: 'session-a' }) }));
afterEach(() => { cleanup(); localStorage.clear(); });
it('restores authenticated previews for session image uploads', () => {
  localStorage.setItem('token', 'synthetic token');
  const id = '11111111-1111-4111-8111-111111111111';
  render(<AttachmentChip attachment={{ id: 'chip', type: 'file', label: 'capture.png', content: `session://attachments/${id}`, mimeType: 'image/png', sessionAttachmentId: id }} onRemove={() => {}} />);
  expect(screen.getByRole('img').getAttribute('src')).toBe(`/api/session-attachments/session-a/${id}/content?token=synthetic%20token`);
});
