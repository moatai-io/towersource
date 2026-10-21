import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { afterEach } from 'vitest';
import { readCanonicalProjectFileBytes } from '../../services/project-environment/adapters/canonical-host-file-adapter.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ writable: vi.fn(), accessible: vi.fn(), findProject: vi.fn(), getProject: vi.fn(), writeProject: vi.fn(), writeLocal: vi.fn(),createLocal:vi.fn() }));
vi.mock('../../config.js', () => ({ config: { workspaceRoot: '/workspace' } }));
vi.mock('../../services/inline-edit/index.js', () => ({}));
vi.mock('../../services/auth/auth.js', () => ({ getUserAllowedPath: vi.fn(async () => '/workspace') }));
vi.mock('../../services/workspace/file-system.js', () => ({ expandHome: (p:string)=>p, writeFileContent: m.writeLocal, createFile:m.createLocal,invalidateTreeCache: vi.fn() }));
vi.mock('../../services/workspace/notes-index.js', () => ({}));
vi.mock('../../services/workspace/knowledge-graph.js', () => ({}));
vi.mock('../../services/workspace/share-manager.js', () => ({}));
vi.mock('../../services/pm/project-access.js', () => ({ findProjectByPath: m.findProject, isPathAccessible: m.accessible, isPathWritableByRole: m.writable, isPrivilegedRole: vi.fn(), isDotfileDenied: vi.fn() }));
vi.mock('../../services/pm/project-manager.js', () => ({ getProject: m.getProject }));
vi.mock('../../services/project-environment/project-workspace-files.js', () => ({ resolveProjectWorkspaceFile: vi.fn(async (input: any) => input), writeProjectWorkspaceText: m.writeProject, readProjectWorkspaceFileForPresentation: async ({reference}:any) => ({storageAuthority:'host',content:readCanonicalProjectFileBytes(reference.projectRoot,reference.relativePath,4096).toString('utf8')}) }));
vi.mock('./project-files-access.js', () => ({ isPathAllowedByCoarseRootOrAcl: vi.fn(async () => true) }));
vi.mock('../../services/runtime-box/workbench-project-file-authority.js', () => ({ assertProjectSharedMutationForHostPath: vi.fn() }));
import router from './project-files-router.js';


// Real HTTP route + production adapter. Identity/ACL/gateway metadata are fixtures,
// not real login or deployed end-to-end coverage.
let root:string,base:string,server:http.Server,url:string;
beforeEach(async()=>{
 vi.clearAllMocks();base=await fs.mkdtemp(path.join(os.tmpdir(),'alias-http-'));root=path.join(base,'project');await fs.mkdir(root);
 await fs.mkdir(path.join(root,'real'));await fs.writeFile(path.join(root,'real/note.txt'),'sample');
 await fs.symlink('real',path.join(root,'final'));await fs.writeFile(path.join(base,'outside.txt'),'outside');await fs.symlink('../outside.txt',path.join(root,'outside'));
 await fs.writeFile(path.join(root,'.env'),'synthetic protected');await fs.symlink('.env',path.join(root,'secret'));
 m.accessible.mockResolvedValue(true);m.findProject.mockResolvedValue('p');m.getProject.mockResolvedValue({rootPath:root});
 const app=express();app.use((req:any,_res,next)=>{req.user={role:'member',userId:7};next();});app.use('/api',router);
 server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.on('listening',r));const addr=server.address() as any;url=`http://127.0.0.1:${addr.port}`;
});
afterEach(async()=>{await new Promise<void>(r=>server.close(()=>r()));await fs.rm(base,{recursive:true,force:true});});
const read=(p:string)=>fetch(`${url}/api/files/read?path=${encodeURIComponent(path.join(root,p))}`);
it('serves identical original and directory alias content through the read route',async()=>{
 for(const name of ['real/note.txt','final/note.txt']){const response=await read(name);const body=await response.json();expect(response.status,JSON.stringify(body)).toBe(200);expect(body).toMatchObject({content:'sample',storageAuthority:'host'});}
});
it.each(['outside','secret'])('denies unsafe alias %s',async name=>{const response=await read(name);expect(response.status).toBe(403);const body=await response.json();expect(body.error).toBe(name==='outside'?'WORKSPACE_READ_ALIAS_OUTSIDE_PROJECT':'WORKSPACE_READ_PROTECTED_PATH');});
it('checks caller Project ACL before allowing internal alias',async()=>{m.accessible.mockResolvedValue(false);const response=await read('final/note.txt');expect(response.status).toBe(403);expect((await response.json()).error).toContain('not a member');});
