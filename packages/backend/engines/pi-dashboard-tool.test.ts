import {describe,it,expect,vi,beforeEach} from 'vitest';
const h=vi.hoisted(()=>({files:new Map<string,string>(),access:true,private:false}));
vi.mock('../services/session/session-artifact-privacy.js',()=>({assertSessionAllowsSharedArtifactWrite:async()=>{if(h.private)throw Error('private')}}));
vi.mock('../services/pm/project-access.js',()=>({resolvePathForAccessBoundary:(p:string)=>p,isPathAccessible:async()=>h.access,isPathWritableByRole:async()=>h.access}));
vi.mock('../services/project-environment/project-workspace-files.js',()=>({resolveProjectWorkspaceFile:async(x:any)=>x,createProjectWorkspaceDirectory:async()=>{},projectWorkspaceEntryExists:async({reference}:any)=>({exists:h.files.has(reference.relativePath)}),readProjectWorkspaceFileBytes:async({reference}:any)=>({bytes:Buffer.from(h.files.get(reference.relativePath)!)}),writeProjectWorkspaceText:async({reference,content,exclusive}:any)=>{if(exclusive&&h.files.has(reference.relativePath))throw Error('exists');h.files.set(reference.relativePath,content)}}));
import {createDashboardTool} from './pi-dashboard-tool';
const declaration={schemaVersion:1,template:'pricing.v1',initialValues:{customers:100,price:50000,discount:10,fixed:2000000,variable:10000}};
const call=async(params:any)=>JSON.parse((await (createDashboardTool({userId:1,projectId:'p',projectRoot:'/project',sessionId:'s'}).execute as any)('id',params)).content[0].text);
beforeEach(()=>{h.files.clear();h.access=true;h.private=false});
describe('dashboard tool',()=>{
 it('saves and reopens identical content without duplication',async()=>{const first=await call({slug:'pricing',declaration});expect(first.ok).toBe(true);expect(first.action).toBe('present_file');expect(first.path).toBe('/project/dashboards/pricing/dashboard.pricing-app.json');expect((await call({slug:'pricing',declaration})).sha256).toBe(first.sha256);expect(h.files.size).toBe(1)});
 it('does not overwrite different content',async()=>{await call({slug:'pricing',declaration});expect((await call({slug:'pricing',declaration:{...declaration,title:'changed'}})).code).toBe('already_exists')});
 it.each(['../escape','/absolute','A',''])('rejects slug %s',async slug=>{expect((await call({slug,declaration})).ok).toBe(false);expect(h.files.size).toBe(0)});
 it('rejects executable declarations',async()=>{expect((await call({slug:'x',declaration:{...declaration,script:'code'}})).ok).toBe(false)});
 it('honors access denial',async()=>{h.access=false;expect((await call({slug:'x',declaration})).ok).toBe(false);expect(h.files.size).toBe(0)});
 it('honors private session restrictions',async()=>{h.private=true;expect((await call({slug:'x',declaration})).ok).toBe(false);expect(h.files.size).toBe(0)});
});
