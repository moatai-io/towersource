import fs from 'node:fs';import path from 'node:path';import{describe,expect,it}from'vitest';
const lifecycle=fs.readFileSync(path.resolve(import.meta.dirname,'harness-lifecycle.ts'),'utf8');
const api=fs.readFileSync(path.resolve(import.meta.dirname,'../../routes/harness-api.ts'),'utf8');
const store=fs.readFileSync(path.resolve(import.meta.dirname,'harness-store.ts'),'utf8');
const policy=fs.readFileSync(path.resolve(import.meta.dirname,'../ai-service/harness-policy.ts'),'utf8');
describe('Harness P0 hardening contracts',()=>{
  it('protects mutation with owner access and namespaces non-privileged Harness ids',()=>{
    expect(api).toContain('isProjectOwner');expect(api).toContain('actorRole:a.role');
    expect(lifecycle).toContain("const namespace=`project-");
    expect(lifecycle).toContain('System Harness publishing requires admin or operator');
  });
  it('publishes and resolves only through the versioned Runtime Profile store',()=>{
    expect(lifecycle).toContain('INSERT INTO harness_runtime_profile_versions');
    expect(lifecycle).not.toContain('INSERT INTO harness_runtime_profiles');
    expect(store).toContain('JOIN harness_runtime_profile_versions');
    expect(policy).toContain('JOIN harness_runtime_profile_versions');
  });
});
