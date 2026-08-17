import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './ai-service-manager.ts'), 'utf8');

describe('AI Service manager overview source contract', () => {
  it('returns current deployment, latest deployment, and latest evaluation for the deployment wizard', () => {
    expect(source).toContain('current_deployment');
    expect(source).toContain('s.owner_project_id AS "ownerProjectId"');
    expect(source).toContain("COALESCE(pap.display_name,p.name) AS \"ownerAgentName\"");
    expect(source).toContain("COALESCE(pap.face,'✨') AS \"ownerAgentFace\"");
    expect(source).toContain('"currentDeployment"');
    expect(source).toContain('"latestDeployment"');
    expect(source).toContain('"latestEvaluation"');
    expect(source).toContain('ORDER BY ld.version DESC LIMIT 1');
    expect(source).toContain('FROM ai_service_runtime_evaluations e');
    expect(source).toContain('ORDER BY e.evaluated_at DESC LIMIT 1');
  });

  it('hides retired agents from the external deployment list after deletion', () => {
    expect(source).toContain("WHERE s.status<>'retired'");
    expect(source).toContain("UPDATE ai_services SET status='retired',current_deployment_id=NULL");
    expect(source).toContain("UPDATE ai_service_channels SET status='disabled',active_deployment_id=NULL");
  });

  it('keeps activation protected by the activation gate before pointer changes', () => {
    expect(source).toContain("export async function activateDeployment(id:string,actor:number,reason:'deploy'|'rollback'='deploy',expectedServiceId?:string):Promise<void>{await assertAIServiceActivationReady");
    expect(source).toContain("UPDATE ai_services SET current_deployment_id=$1,status='active'");
    expect(source).toContain("UPDATE ai_service_channels SET active_deployment_id=$1,status='enabled'");
  });

  it('hides retired agents from the active external deployment list', () => {
    expect(source).toContain("WHERE s.status<>'retired'");
    expect(source).toContain("UPDATE ai_services SET status='retired',current_deployment_id=NULL");
    expect(source).toContain("UPDATE ai_service_channels SET status='disabled',active_deployment_id=NULL");
  });

  it('offers one-click deploy by automating internal draft/review/activation steps', () => {
    expect(source).toContain('deployServiceNow');
    expect(source).toContain('submitDeploymentForReview');
    expect(source).toContain('approveDeployment');
    expect(source).toContain('recordServerDeployCheck');
    expect(source).toContain('activateDeployment');
    expect(source).toContain("channel_type='web_link'");
    expect(source).toContain('createWebLinkChannel');
  });
});
