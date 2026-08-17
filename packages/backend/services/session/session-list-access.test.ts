import { describe, expect, it } from 'vitest';
import { isSessionListVisibleToUser, type SessionListAccessRow } from './session-manager.js';

const USER_ID = 10;
const OTHER_USER_ID = 20;
const ACCESSIBLE_PROJECTS = ['project-allowed'];

function row(overrides: Partial<SessionListAccessRow>): SessionListAccessRow {
  return {
    user_id: OTHER_USER_ID,
    project_id: 'project-allowed',
    visibility: 'project',
    label: 'temp',
    ...overrides,
  };
}

describe('session list metadata access', () => {
  it('hides other users private project session metadata from project members', () => {
    const visible = isSessionListVisibleToUser(
      row({ visibility: 'private' }),
      USER_ID,
      ACCESSIBLE_PROJECTS,
    );

    expect(visible).toBe(false);
  });

  it('shows other users project-shared session metadata only inside accessible projects', () => {
    expect(isSessionListVisibleToUser(
      row({ project_id: 'project-allowed', visibility: 'project' }),
      USER_ID,
      ACCESSIBLE_PROJECTS,
    )).toBe(true);

    expect(isSessionListVisibleToUser(
      row({ project_id: 'project-secret', visibility: 'project' }),
      USER_ID,
      ACCESSIBLE_PROJECTS,
    )).toBe(false);
  });

  it('hides project-less legacy/temp sessions unless the caller owns them', () => {
    expect(isSessionListVisibleToUser(
      row({ user_id: OTHER_USER_ID, project_id: null, visibility: 'project' }),
      USER_ID,
      ACCESSIBLE_PROJECTS,
    )).toBe(false);

    expect(isSessionListVisibleToUser(
      row({ user_id: USER_ID, project_id: null, visibility: 'private' }),
      USER_ID,
      ACCESSIBLE_PROJECTS,
    )).toBe(true);
  });

  it('does not leak metadata when JWT role is missing and caller is non-privileged', () => {
    // getSessions now passes role || 'member' into getAccessibleProjectIds; a
    // role-less authenticated caller must therefore receive a non-null project
    // list here, not the admin/operator null sentinel.
    expect(isSessionListVisibleToUser(
      row({ user_id: OTHER_USER_ID, project_id: null, visibility: 'project', label: 'temp' }),
      USER_ID,
      ACCESSIBLE_PROJECTS,
    )).toBe(false);
  });

  it('allows only the intentional project-less channel AI system exception', () => {
    expect(isSessionListVisibleToUser(
      row({ user_id: null, project_id: null, label: 'channel_ai' }),
      USER_ID,
      ACCESSIBLE_PROJECTS,
    )).toBe(true);

    expect(isSessionListVisibleToUser(
      row({ user_id: null, project_id: null, label: 'temp' }),
      USER_ID,
      ACCESSIBLE_PROJECTS,
    )).toBe(false);
  });
});
