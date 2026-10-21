/** Creates a validated, file-backed dashboard. No executable declarations. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { parsePricingDeclaration } from '../../shared/pricing-app.js';
import { assertSessionAllowsSharedArtifactWrite } from '../services/session/session-artifact-privacy.js';
import { isPathAccessible, isPathWritableByRole, resolvePathForAccessBoundary } from '../services/pm/project-access.js';
import { resolveProjectWorkspaceFile, createProjectWorkspaceDirectory, writeProjectWorkspaceText, projectWorkspaceEntryExists, readProjectWorkspaceFileBytes } from '../services/project-environment/project-workspace-files.js';
interface Context { userId?: number; userRole?: string; projectId?: string; projectRoot?: string; sessionId?: string }
export function createDashboardTool(ctx: Context): ToolDefinition {
  return {
    name: 'create_dashboard', label: '대시보드 저장',
    description: 'Validate and save a host-owned pricing dashboard in dashboards/<slug>/dashboard.pricing-app.json, then request Viewer presentation. Existing different content is never overwritten. Does not publish or grant access.',
    parameters: Type.Object({ slug: Type.String({pattern:'^[a-z0-9][a-z0-9-]{0,63}$'}), declaration: Type.Object({schemaVersion:Type.Literal(1),template:Type.Literal('pricing.v1'),title:Type.Optional(Type.String({maxLength:120})),initialValues:Type.Object({customers:Type.Integer({minimum:0,maximum:1000000}),price:Type.Integer({minimum:0,maximum:1000000000}),discount:Type.Integer({minimum:0,maximum:100}),fixed:Type.Integer({minimum:0,maximum:1000000000}),variable:Type.Integer({minimum:0,maximum:1000000000})},{additionalProperties:false})},{additionalProperties:false}) },{additionalProperties:false}),
    async execute(_id: string, params: {slug:string;declaration:unknown}) {
      const result=(payload:object,isError=false)=>({content:[{type:'text' as const,text:JSON.stringify(payload)}],details:payload,isError});
      try {
        if (!ctx.userId || !ctx.projectId || !ctx.projectRoot) throw new Error('context');
        await assertSessionAllowsSharedArtifactWrite(ctx.sessionId);
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(params.slug)) throw new Error('slug');
        const declaration=parsePricingDeclaration(params.declaration);
        const relativePath=`dashboards/${params.slug}/dashboard.pricing-app.json`;
        const target=path.resolve(ctx.projectRoot,relativePath);
        const resolved=resolvePathForAccessBoundary(target);
        const root=resolvePathForAccessBoundary(ctx.projectRoot);
        if (!resolved.startsWith(root+path.sep)) throw new Error('boundary');
        for(const candidate of [target,resolved]) {
          if (!await isPathAccessible(candidate,ctx.userId,ctx.userRole||'member') || !await isPathWritableByRole(candidate,ctx.userId,ctx.userRole||'member')) throw new Error('access');
        }
        const reference=await resolveProjectWorkspaceFile({projectId:ctx.projectId,projectRoot:ctx.projectRoot,relativePath});
        const content=JSON.stringify(declaration,null,2)+'\n';
        const same=async()=> (await readProjectWorkspaceFileBytes({reference,actorUserId:ctx.userId!,maxBytes:262144})).bytes.toString('utf8')===content;
        if ((await projectWorkspaceEntryExists({reference,actorUserId:ctx.userId})).exists) {
          if (!await same()) return result({ok:false,code:'already_exists',userMessage:'다른 내용의 대시보드가 있습니다. 다른 이름으로 저장하세요.'},true);
        } else {
          const directory=await resolveProjectWorkspaceFile({projectId:ctx.projectId,projectRoot:ctx.projectRoot,relativePath:path.posix.dirname(relativePath)});
          await createProjectWorkspaceDirectory({reference:directory,actorUserId:ctx.userId,exclusive:false});
          try { await writeProjectWorkspaceText({reference,actorUserId:ctx.userId,content,exclusive:true}); }
          catch(error) { if (!(await projectWorkspaceEntryExists({reference,actorUserId:ctx.userId})).exists || !await same()) throw error; }
        }
        return result({ok:true,action:'present_file',path:target,label:declaration.title||'가격 시뮬레이터',presentation:'viewer',reveal:true,split:'right',focus:true,status:'saved',sha256:createHash('sha256').update(content).digest('hex')});
      } catch { return result({ok:false,code:'dashboard_save_failed',userMessage:'대시보드를 저장하지 못했습니다. 선언 형식과 현재 Project 쓰기 권한을 확인하세요.'},true); }
    },
  } as ToolDefinition;
}
