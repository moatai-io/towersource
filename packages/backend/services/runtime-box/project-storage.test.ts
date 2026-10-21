import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectStorage } from './project-storage.js';
import { assertStorageGroupIdentity, parseProjectStorageGroupPolicy, verifyConfiguredStorageGroup } from './project-storage-group-policy.js';

const roots: string[]=[];
const fixture=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'tower-project-storage-'));roots.push(root);return root;};
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

describe('ProjectStorage boundary',()=>{
  it('classifies shared, managed and private namespaces',()=>{
    const s=new ProjectStorage(fixture());
    expect(s.resolve('work/a.txt').namespace).toBe('shared');
    expect(s.resolve('.tower/skills/manifest.json').namespace).toBe('managed-readonly');
    expect(s.resolve('.git/config').namespace).toBe('managed-readonly');
    expect(s.resolve('.tower-run-credentials/run/x').namespace).toBe('private');
    expect(s.resolve('.env').namespace).toBe('private');
  });
  it('rejects escape, absolute and symlink ancestors',()=>{
    const root=fixture(),s=new ProjectStorage(root);fs.symlinkSync('/tmp',path.join(root,'link'));
    for(const value of ['../x','/tmp/x','\0'])expect(()=>s.resolve(value)).toThrow();
    expect(()=>s.assertMutation('link/x')).toThrow('ANCESTOR_UNTRUSTED');
  });
  it('allows only the explicitly requested namespace',()=>{
    const s=new ProjectStorage(fixture());
    expect(s.assertMutation('work/x')).toContain('/work/x');
    expect(()=>s.assertMutation('.tower/x')).toThrow('managed-readonly');
    expect(s.assertMutation('.tower/x','managed-readonly')).toContain('/.tower/x');
  });
});

describe('storage group installation contract',()=>{
 const policy=parseProjectStorageGroupPolicy(JSON.stringify({version:1,mode:'shared-group',storageGid:3000,backendUid:1000,workerUid:998}));
 it('requires distinct non-root identities and a stable group',()=>{
   expect(policy.storageGid).toBe(3000);
   for(const bad of [{...policy,storageGid:0},{...policy,workerUid:1000},{...policy,extra:true}])expect(()=>parseProjectStorageGroupPolicy(JSON.stringify(bad))).toThrow();
 });
 it('requires both live identities to carry the storage group',()=>{
   expect(()=>assertStorageGroupIdentity(policy,'backend',{uid:1000,gid:1000,groups:[3000]})).not.toThrow();
   expect(()=>assertStorageGroupIdentity(policy,'worker',{uid:998,gid:998,groups:[3000]})).not.toThrow();
   expect(()=>assertStorageGroupIdentity(policy,'worker',{uid:998,gid:998,groups:[]})).toThrow('WORKER_GROUP');
   expect(()=>assertStorageGroupIdentity(policy,'backend',{uid:998,gid:998,groups:[3000]})).toThrow('BACKEND_GROUP');
 });
 it('is inert when unconfigured and fails closed before reading processes when configured without both PIDs',()=>{
   expect(verifyConfiguredStorageGroup({})).toBe('unconfigured');
   expect(()=>verifyConfiguredStorageGroup({TOWER_PROJECT_STORAGE_GROUP_POLICY:JSON.stringify(policy)})).toThrow('PROCESS_PIDS_REQUIRED');
 });
});
