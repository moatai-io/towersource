/** Primary Agent preview-intent and creation command API. */
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { buildPrimaryAgentBootstrapPayload } from '../services/agents/primary-agent-bootstrap.js';
import { createPrimaryAgentCommand } from '../services/agents/primary-agent-creation.js';
import { createPrimaryAgentCreationIntent } from '../services/agents/primary-agent-creation-intent.js';
import { validatePrimaryAgentHarnessBinding } from '../services/agents/primary-agent-staffing.js';

const router = Router();
const capabilityRequirementsSchema = z.object({
  required:z.array(z.string().min(1)),optional:z.array(z.string().min(1)).optional(),forbidden:z.array(z.string().min(1)).optional(),
  dataSources:z.array(z.string().min(1)).optional(),externalActions:z.array(z.string().min(1)).optional(),approvalConditions:z.array(z.string().min(1)).optional(),
});
const roiContractSchema = z.object({
  primaryMetric:z.string().min(1),baseline:z.string().max(1000).optional(),target:z.string().min(1).max(1000),
  confidence:z.enum(['low','medium','high']).optional(),reviewAfterDays:z.number().int().min(1).max(365).optional(),
}).optional();
const staffingSchema = z.object({
  name:z.string().min(1).max(120),description:z.string().max(1000).optional(),face:z.string().min(1).max(120),tagline:z.string().min(1).max(300),role:z.string().min(1).max(1000),promise:z.string().min(1).max(1000),instruction:z.string().min(1).max(12000),firstMission:z.string().min(1).max(1000),
  authorityPolicy:z.record(z.string(),z.unknown()).optional(),toolPolicy:z.record(z.string(),z.unknown()).optional(),roiContract:roiContractSchema,
  capabilityRequirements:capabilityRequirementsSchema,
  harnessBinding:z.object({harnessId:z.string().min(1),harnessVersion:z.number().int().positive(),runtimeProfileId:z.string().min(1),runtimeProfileVersion:z.number().int().positive()}),
});
const previewSchema = staffingSchema.extend({ sourceProjectId:z.string().min(1) });
const commandSchema = staffingSchema.extend({
  idempotencyKey:z.string().min(8).max(200),approvedCardHash:z.string().length(64),approvalIntentId:z.string().min(1),sourceProjectId:z.string().min(1),
});
const bootstrapPreviewSchema=z.object({sourceProjectId:z.string().min(1),name:z.string().min(1).max(120),face:z.string().min(1).max(120),expertiseIntent:z.string().min(1).max(1000).optional(),expectedExpertise:z.string().min(1).max(1000).optional()}).superRefine((value,ctx)=>{if(!value.expertiseIntent&&!value.expectedExpertise)ctx.addIssue({code:'custom',message:'expertiseIntent is required',path:['expertiseIntent']})});
const bootstrapCommandSchema=z.object({sourceProjectId:z.string().min(1),name:z.string().min(1).max(120),face:z.string().min(1).max(120),expertiseIntent:z.string().min(1).max(1000).optional(),expectedExpertise:z.string().min(1).max(1000).optional()}).superRefine((value,ctx)=>{if(!value.expertiseIntent&&!value.expectedExpertise)ctx.addIssue({code:'custom',message:'expertiseIntent is required',path:['expertiseIntent']})});

function actor(req:any){const userId=req.user?.userId,role=String(req.user?.role||'member');if(!Number.isInteger(userId))throw new Error('auth required');return{userId,role}}
function fail(res:any,error:any){const message=error?.message||'Primary Agent creation failed';const status=message==='auth required'?401:/restricted|cannot create|intent required|hash does not match|unavailable/i.test(message)?403:/Idempotency key|unused server-approved/i.test(message)?409:error?.name==='ZodError'?400:500;if(status===500)console.error('[primary-agent-api]',error);res.status(status).json({error:message,details:error?.details})}

router.post('/bootstrap-preview-intents',async(req,res)=>{try{
  if(!config.agentFirstEnabled)return res.status(404).json({error:'Agent-first feature is not enabled'});
  const a=actor(req),body=bootstrapPreviewSchema.parse(req.body);
  const {sourceProjectId,expertiseIntent,expectedExpertise,...identity}=body;
  const expanded=await buildPrimaryAgentBootstrapPayload({...identity,expertiseIntent:expertiseIntent||expectedExpertise!});
  await validatePrimaryAgentHarnessBinding({sourceProjectId,binding:expanded.payload.harnessBinding,requirements:expanded.payload.capabilityRequirements});
  const intent=await createPrimaryAgentCreationIntent({actorUserId:a.userId,actorRole:a.role,sourceProjectId,payload:expanded.payload});
  res.status(201).json({...intent,card:expanded.card,harnessBinding:expanded.payload.harnessBinding});
}catch(error){fail(res,error)}});

router.post('/bootstrap',async(req,res)=>{try{
  if(!config.agentFirstEnabled)return res.status(404).json({error:'Agent-first feature is not enabled'});
  const a=actor(req),body=bootstrapCommandSchema.parse(req.body);
  const {sourceProjectId,expertiseIntent,expectedExpertise,...identity}=body;
  const expanded=await buildPrimaryAgentBootstrapPayload({...identity,expertiseIntent:expertiseIntent||expectedExpertise!});
  await validatePrimaryAgentHarnessBinding({sourceProjectId,binding:expanded.payload.harnessBinding,requirements:expanded.payload.capabilityRequirements});
  const intent=await createPrimaryAgentCreationIntent({actorUserId:a.userId,actorRole:a.role,sourceProjectId,payload:expanded.payload});
  const idempotencyKey=`agent-bootstrap:${a.userId}:${sourceProjectId}:${intent.staffingHash}`;
  res.status(201).json(await createPrimaryAgentCommand({...expanded.payload,idempotencyKey,approvedCardHash:intent.staffingHash,approvalIntentId:intent.approvalIntentId,sourceProjectId,actorUserId:a.userId}));
}catch(error){fail(res,error)}});

router.post('/preview-intents',async(req,res)=>{try{
  if(!config.agentFirstEnabled)return res.status(404).json({error:'Agent-first feature is not enabled'});
  const a=actor(req),body=previewSchema.parse(req.body);
  const {sourceProjectId,...payload}=body;
  await validatePrimaryAgentHarnessBinding({sourceProjectId,binding:payload.harnessBinding,requirements:payload.capabilityRequirements});
  res.status(201).json(await createPrimaryAgentCreationIntent({actorUserId:a.userId,actorRole:a.role,sourceProjectId,payload}));
}catch(error){fail(res,error)}});

router.post('/',async(req,res)=>{try{
  if(!config.agentFirstEnabled)return res.status(404).json({error:'Agent-first feature is not enabled'});
  const a=actor(req),body=commandSchema.parse(req.body);
  res.status(201).json(await createPrimaryAgentCommand({...body,actorUserId:a.userId}));
}catch(error){fail(res,error)}});
export default router;
