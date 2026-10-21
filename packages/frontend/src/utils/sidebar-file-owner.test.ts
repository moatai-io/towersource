// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ projects: [] as {id:string; rootPath:string}[], activeProjectId: 'a' }));
vi.mock('../stores/project-store', () => ({ useProjectStore: { getState: () => state } }));
vi.mock('../stores/session-store', () => ({ useSessionStore: { getState: () => ({ sessions: [{id:'s',projectId:state.activeProjectId}], activeSessionId: 's' }) } }));
vi.mock('../stores/room-store', () => ({ useRoomStore: { getState: () => ({ rooms: [], activeRoomId: null }) } }));
import { findOwningProjectForPath, normalizeSidebarFilePath } from './sidebar-file-owner';
beforeEach(() => { state.projects = [{ id: 'a', rootPath: '/home/test/workspace/projects/demo' }, { id:'b',rootPath:'/home/test/workspace/projects/demo/nested' },{id:'c',rootPath:'/home/test/workspace/projects/demo-other'}]; });
it('maps portable workspace spelling to the actual sidebar path and owner', () => {
 expect(normalizeSidebarFilePath(' ~/workspace/projects/demo/한글.md ')).toBe('/home/test/workspace/projects/demo/한글.md');
 expect(findOwningProjectForPath(state.projects,'~/workspace/projects/demo/한글.md')?.id).toBe('a');
});
it('keeps longest boundary matching instead of sibling-prefix guesses', () => {
 expect(findOwningProjectForPath(state.projects,'~/workspace/projects/demo/nested/a.md')?.id).toBe('b');
 expect(findOwningProjectForPath(state.projects,'~/workspace/projects/demo-other/a.md')?.id).toBe('c');
 expect(findOwningProjectForPath(state.projects,'~/workspace/projects/demo-unknown/a.md')).toBeUndefined();
});
it('does not mutate the Project list or guess unrecognized home aliases', () => {
 const before=[...state.projects];
 expect(findOwningProjectForPath(state.projects,'~/other-private/a.md')).toBeUndefined();
 expect(state.projects).toEqual(before);
});
it('normalizes trailing slash and preserves decomposed filename characters', () => {
 expect(findOwningProjectForPath(state.projects,'/home/test/workspace/projects/demo/')).toBe(state.projects[0]);
 const name='테스트.md';expect(normalizeSidebarFilePath(`~/workspace/projects/demo/${name}`)).toContain(name);
});

it('never guesses an old runtime path from the currently active conversation', () => {
 state.activeProjectId='a';
 expect(normalizeSidebarFilePath('/workspace/old.md')).toBe('/workspace/old.md');
 expect(findOwningProjectForPath(state.projects,'/workspace/old.md')).toBeUndefined();
 state.activeProjectId='c';
 expect(findOwningProjectForPath(state.projects,'/workspace/old.md')).toBeUndefined();
});
