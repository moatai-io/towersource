import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const apiSource = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const membershipSource = readFileSync(new URL('../services/pm/project-membership-manager.ts', import.meta.url), 'utf8');

describe('Publishing Hub project membership scope source contract', () => {
  it('scopes the ordinary Hub to actual project memberships even for privileged roles', () => {
    const route = apiSource.slice(
      apiSource.indexOf("router.get('/publish/status'"),
      apiSource.indexOf("router.get('/publish/stats'"),
    );

    expect(route).toContain('getProjectMembershipIds(user.userId)');
    expect(route).toContain('status.sites = status.sites.filter');
    expect(route).toContain('status.apps = status.apps.filter');
    expect(route).not.toContain('getAccessibleProjectIds');
  });

  it('keeps membership lookup distinct from elevated all-project access', () => {
    const membershipFn = membershipSource.slice(
      membershipSource.indexOf('export async function getProjectMembershipIds'),
      membershipSource.indexOf('export async function getAccessibleProjectIds'),
    );

    expect(membershipFn).toContain('project_members');
    expect(membershipFn).not.toContain("role === 'admin'");
    expect(membershipFn).not.toContain("role === 'operator'");
  });

  it('scopes tag aggregation to the same project set', () => {
    const route = apiSource.slice(
      apiSource.indexOf("router.get('/publish/sites/tags'"),
      apiSource.indexOf("router.patch('/publish/sites/:slug/tags'"),
    );

    expect(route).toContain('getProjectMembershipIds(user.userId)');
    expect(route).toContain('if (!site.project || !allowed.has(site.project)) continue');
  });
});
