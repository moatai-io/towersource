import {describe,it,expect} from 'vitest';
import {scopePublications} from './project-scope';
describe('publication scope',()=>{
 const map={p1:'one',p2:'two'};
 it('adds canonical ownership only to authorized items',()=>expect(scopePublications([{project:'one'},{project:'two'}],map,['p1'])).toEqual([{project:'one',ownerProjectId:'p1'}]));
 it('supports a Project view over the same authorized inventory',()=>expect(scopePublications([{project:'one'},{project:'two'}],map,['p1','p2'],'p2')).toEqual([{project:'two',ownerProjectId:'p2'}]));
 it('cannot expand authority using a project filter',()=>expect(scopePublications([{project:'two'}],map,['p1'],'p2')).toEqual([]));
 it('rejects ambiguous legacy folder names even if one owner is accessible',()=>expect(scopePublications([{project:'same'}],{p1:'same',p2:'same'},['p1'])).toEqual([]));
 it('accepts canonical IDs',()=>expect(scopePublications([{project:'p1'}],map,['p1'])[0].ownerProjectId).toBe('p1'));
 it('fails closed on unknown or missing mapping',()=>expect(scopePublications([{project:'one'},{}],{},['p1'])).toEqual([]));
 it('rejects collisions between canonical IDs and legacy folder keys',()=>expect(scopePublications([{project:'p1'}],{p1:'one',p2:'p1'},['p1'])).toEqual([]));
});
