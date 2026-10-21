import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
const source=readFileSync(new URL('./PublishPanel.tsx',import.meta.url),'utf8');
it('filters sites and apps by canonical owner identity',()=>{expect(source).toContain('site.ownerProjectId === ownerFilter');expect(source).toContain('app.ownerProjectId === ownerFilter');expect(source).not.toContain('site.project === ownerFilter')});
it('keeps unknown shared-file ownership out of Agent scopes',()=>expect(source).toContain('sharedFiles.filter(s => !s.expired && !ownerFilter)'));
it('provides all-Agent discovery and clears stale selection',()=>{expect(source).toContain('<option value="">');expect(source).toContain("setOwnerFilter('')");expect(source).toContain('publish-agent-filter')});
it('accepts an Agent-home entry scope',()=>{
 expect(source).toContain('initialProjectId?: string');
 expect(source).toContain('if (open) setOwnerFilter(initialProjectId');
 const home=readFileSync(new URL('../files/ProjectHome.tsx',import.meta.url),'utf8');
 expect(home).toContain('initialProjectId={project.id}');
 expect(home).toContain("t('projectHome.publishingHub')");
});
