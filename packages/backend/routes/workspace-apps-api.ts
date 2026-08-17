import { Router } from 'express';
import { config } from '../config.js';
import { loadWorkspaceAppDefinitions } from '../services/workspace-apps/app-definition-loader.js';
import { listWorkspaceAppDrafts, readWorkspaceAppDraft, saveWorkspaceAppDraft } from '../services/workspace-apps/app-draft-store.js';
import { WorkspaceAppBuilderDraftPreviewSchema } from '../services/workspace-apps/app-definition-schema.js';
import { executeWorkspaceAppAction, WorkspaceAppActionPayloadSchema } from '../services/workspace-apps/app-action-executor.js';
import { applyWorkspaceAppDraftPublish, previewWorkspaceAppDraftPublish } from '../services/workspace-apps/app-publish-preview.js';
import { runWorkspaceAppReadOnlyQuery } from '../services/workspace-apps/neon-connection.js';
import { runWorkspaceAppSqliteReadOnlyQuery } from '../services/workspace-apps/sqlite-connection.js';
import { describeFrappeDocType, listFrappeDocTypes, listFrappeRecords, parseFrappeCredentialValue, readFrappeRecord, summarizeFrappeConnectionReadiness } from '../services/workspace-apps/frappe-connector.js';
import { createMockFrappeRecord, describeMockFrappeObject, listMockFrappeObjects, listMockFrappeRecords, readMockFrappeRecord, transitionMockFrappeRecord, updateMockFrappeRecord } from '../services/workspace-apps/mock-frappe-connector.js';
import { findWorkspaceAppReadQuery } from '../services/workspace-apps/query-policy.js';
import { resolveProjectCredentialSecretValue } from '../services/credential-vault/credential-vault-service.js';
import { getProject } from '../services/pm/project-manager.js';
import { isProjectMember } from '../services/pm/project-membership-manager.js';
import { isPrivilegedRole } from '../services/pm/project-access.js';

const router = Router();

async function canReadProjectApps(projectId: string, userId: number | undefined, role: string | undefined): Promise<boolean> {
  if (!userId || !role) return false;
  if (isPrivilegedRole(role)) return true;
  const project = await getProject(projectId);
  if (!project) return false;
  if (project.userId === userId) return true;
  return isProjectMember(projectId, userId);
}

async function canManageProjectApps(projectId: string, userId: number | undefined, role: string | undefined): Promise<boolean> {
  if (!userId || !role) return false;
  if (role === 'viewer' || role === 'guest') return false;
  return canReadProjectApps(projectId, userId, role);
}

function resolveDefinition(projectRoot: string, appId: string) {
  return loadWorkspaceAppDefinitions(projectRoot).find((definition) => definition.id === appId) ?? null;
}

router.get('/', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    if (!projectId) return res.json({ apps: [] });
    if (!(await canReadProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project access denied' });

    const project = await getProject(projectId);
    if (!project?.rootPath) return res.status(404).json({ error: 'project not found' });
    res.json({ apps: loadWorkspaceAppDefinitions(project.rootPath) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'failed to load workspace apps' });
  }
});

function requireFrappeCredentialMaterializationUserId(userId: number | undefined): number {
  if (!userId) throw new Error('Frappe connection materialization requires an authenticated user');
  return userId;
}

async function resolveFrappeConnectionFromCredential(input: {
  projectId: string;
  userId: number;
  connectionId: string;
}) {
  const resolved = await resolveProjectCredentialSecretValue({
    projectId: input.projectId,
    userId: input.userId,
    credentialId: input.connectionId,
    provider: 'frappe',
    targetType: 'workspace_apps_frappe_connector',
  });
  if (!resolved?.value) throw new Error('Frappe connection is not available to this project');
  return parseFrappeCredentialValue(resolved.value);
}

router.get('/connectors/frappe/connections/:connectionId/readiness', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    const connectionId = String(req.params.connectionId || '').trim();
    if (!projectId || !connectionId) return res.status(400).json({ error: 'projectId and connectionId are required' });
    if (!(await canReadProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project access denied' });
    const connection = await resolveFrappeConnectionFromCredential({ projectId, userId: requireFrappeCredentialMaterializationUserId(userId), connectionId });
    res.json({ readiness: summarizeFrappeConnectionReadiness(connection) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to check Frappe connection readiness' });
  }
});


router.get('/connectors/frappe/connections/:connectionId/doctypes', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    const connectionId = String(req.params.connectionId || '').trim();
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    if (!projectId || !connectionId) return res.status(400).json({ error: 'projectId and connectionId are required' });
    if (!(await canReadProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project access denied' });
    const connection = await resolveFrappeConnectionFromCredential({ projectId, userId: requireFrappeCredentialMaterializationUserId(userId), connectionId });
    res.json({ objects: await listFrappeDocTypes({ ...connection, query: { search, limit } }) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to list Frappe DocTypes' });
  }
});

router.get('/connectors/frappe/connections/:connectionId/doctypes/:doctype', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    const connectionId = String(req.params.connectionId || '').trim();
    const doctype = String(req.params.doctype || '').trim();
    if (!projectId || !connectionId || !doctype) return res.status(400).json({ error: 'projectId, connectionId and doctype are required' });
    if (!(await canReadProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project access denied' });
    const connection = await resolveFrappeConnectionFromCredential({ projectId, userId: requireFrappeCredentialMaterializationUserId(userId), connectionId });
    res.json({ schema: await describeFrappeDocType({ ...connection, doctype }) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to describe Frappe DocType' });
  }
});

router.get('/connectors/frappe/connections/:connectionId/doctypes/:doctype/records', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    const connectionId = String(req.params.connectionId || '').trim();
    const doctype = String(req.params.doctype || '').trim();
    const fields = typeof req.query.fields === 'string' ? req.query.fields.split(',').map((field) => field.trim()).filter(Boolean) : ['name'];
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    if (!projectId || !connectionId || !doctype) return res.status(400).json({ error: 'projectId, connectionId and doctype are required' });
    if (!(await canReadProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project access denied' });
    const connection = await resolveFrappeConnectionFromCredential({ projectId, userId: requireFrappeCredentialMaterializationUserId(userId), connectionId });
    res.json({ records: await listFrappeRecords({ ...connection, objectId: doctype.toLowerCase().replace(/\s+/g, '-'), doctype, fields, query: { search, limit } }) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to list Frappe records' });
  }
});

router.get('/connectors/frappe/connections/:connectionId/doctypes/:doctype/records/:recordId', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    const connectionId = String(req.params.connectionId || '').trim();
    const doctype = String(req.params.doctype || '').trim();
    const recordId = String(req.params.recordId || '').trim();
    if (!projectId || !connectionId || !doctype || !recordId) return res.status(400).json({ error: 'projectId, connectionId, doctype and recordId are required' });
    if (!(await canReadProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project access denied' });
    const connection = await resolveFrappeConnectionFromCredential({ projectId, userId: requireFrappeCredentialMaterializationUserId(userId), connectionId });
    res.json({ record: await readFrappeRecord({ ...connection, objectId: doctype.toLowerCase().replace(/\s+/g, '-'), doctype, recordId }) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to read Frappe record' });
  }
});

router.get('/connectors/frappe/mock/objects', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    if (!(await canReadProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project access denied' });
    res.json({ objects: listMockFrappeObjects() });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to list mock Frappe objects' });
  }
});

router.get('/connectors/frappe/mock/objects/:objectId', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    const objectId = String(req.params.objectId || '').trim();
    if (!projectId || !objectId) return res.status(400).json({ error: 'projectId and objectId are required' });
    if (!(await canReadProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project access denied' });
    res.json({ schema: describeMockFrappeObject(objectId) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to describe mock Frappe object' });
  }
});

router.get('/connectors/frappe/mock/objects/:objectId/records', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    const objectId = String(req.params.objectId || '').trim();
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    if (!projectId || !objectId) return res.status(400).json({ error: 'projectId and objectId are required' });
    if (!(await canReadProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project access denied' });
    res.json({ records: listMockFrappeRecords(objectId, { search, limit }) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to list mock Frappe records' });
  }
});

router.get('/connectors/frappe/mock/objects/:objectId/records/:recordId', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    const objectId = String(req.params.objectId || '').trim();
    const recordId = String(req.params.recordId || '').trim();
    if (!projectId || !objectId || !recordId) return res.status(400).json({ error: 'projectId, objectId and recordId are required' });
    if (!(await canReadProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project access denied' });
    res.json({ record: readMockFrappeRecord(objectId, recordId) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to read mock Frappe record' });
  }
});

router.post('/connectors/frappe/mock/objects/:objectId/actions/:actionId', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const objectId = String(req.params.objectId || '').trim();
    const actionId = String(req.params.actionId || '').trim();
    const recordId = typeof req.body?.recordId === 'string' ? req.body.recordId.trim() : '';
    const values = req.body?.values && typeof req.body.values === 'object' ? req.body.values as Record<string, unknown> : {};
    if (!projectId || !objectId || !actionId) return res.status(400).json({ error: 'projectId, objectId and actionId are required' });
    if (!(await canManageProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project app action denied' });
    if (actionId === 'create') return res.status(201).json({ receipt: createMockFrappeRecord(objectId, values) });
    if (actionId === 'update') {
      if (!recordId) return res.status(400).json({ error: 'recordId is required' });
      return res.status(201).json({ receipt: updateMockFrappeRecord(objectId, recordId, values) });
    }
    if (actionId.startsWith('transition:')) {
      if (!recordId) return res.status(400).json({ error: 'recordId is required' });
      return res.status(201).json({ receipt: transitionMockFrappeRecord(objectId, recordId, actionId.slice('transition:'.length)) });
    }
    return res.status(400).json({ error: 'unsupported mock Frappe action' });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to run mock Frappe action' });
  }
});

router.get('/:appId/drafts', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    const appId = String(req.params.appId || '').trim();
    if (!projectId || !appId) return res.status(400).json({ error: 'projectId and appId are required' });
    if (!(await canReadProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project access denied' });

    const project = await getProject(projectId);
    if (!project?.rootPath) return res.status(404).json({ error: 'project not found' });
    const definition = resolveDefinition(project.rootPath, appId);
    if (!definition) return res.status(404).json({ error: 'workspace app definition not found' });
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20;
    res.json({ drafts: listWorkspaceAppDrafts({ projectRoot: project.rootPath, appId: definition.id, limit }) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to list workspace app drafts' });
  }
});

router.get('/:appId/drafts/:draftId', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    const appId = String(req.params.appId || '').trim();
    const draftId = String(req.params.draftId || '').trim();
    if (!projectId || !appId || !draftId) return res.status(400).json({ error: 'projectId, appId and draftId are required' });
    if (!(await canReadProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project access denied' });

    const project = await getProject(projectId);
    if (!project?.rootPath) return res.status(404).json({ error: 'project not found' });
    const definition = resolveDefinition(project.rootPath, appId);
    if (!definition) return res.status(404).json({ error: 'workspace app definition not found' });
    const draft = readWorkspaceAppDraft({ projectRoot: project.rootPath, appId: definition.id, draftId });
    if (!draft) return res.status(404).json({ error: 'workspace app draft not found' });
    res.json({ draft });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to read workspace app draft' });
  }
});

router.post('/:appId/drafts/:draftId/publish-preview', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const appId = String(req.params.appId || '').trim();
    const draftId = String(req.params.draftId || '').trim();
    if (!projectId || !appId || !draftId) return res.status(400).json({ error: 'projectId, appId and draftId are required' });
    if (!(await canManageProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project app management denied' });

    const project = await getProject(projectId);
    if (!project?.rootPath) return res.status(404).json({ error: 'project not found' });
    const definition = resolveDefinition(project.rootPath, appId);
    if (!definition) return res.status(404).json({ error: 'workspace app definition not found' });
    const draft = readWorkspaceAppDraft({ projectRoot: project.rootPath, appId: definition.id, draftId });
    if (!draft) return res.status(404).json({ error: 'workspace app draft not found' });
    res.json({ preview: previewWorkspaceAppDraftPublish({ projectRoot: project.rootPath, definition, draft }) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to preview workspace app publish' });
  }
});

router.post('/:appId/drafts/:draftId/publish', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const previewHash = typeof req.body?.previewHash === 'string' ? req.body.previewHash.trim() : '';
    const expectedBeforeHash = typeof req.body?.expectedBeforeHash === 'string' ? req.body.expectedBeforeHash.trim() : '';
    const confirmed = req.body?.confirmed === true;
    const appId = String(req.params.appId || '').trim();
    const draftId = String(req.params.draftId || '').trim();
    if (!projectId || !appId || !draftId || !previewHash || !expectedBeforeHash) {
      return res.status(400).json({ error: 'projectId, appId, draftId, previewHash and expectedBeforeHash are required' });
    }
    if (!(await canManageProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project app management denied' });

    const project = await getProject(projectId);
    if (!project?.rootPath) return res.status(404).json({ error: 'project not found' });
    const definition = resolveDefinition(project.rootPath, appId);
    if (!definition) return res.status(404).json({ error: 'workspace app definition not found' });
    const draft = readWorkspaceAppDraft({ projectRoot: project.rootPath, appId: definition.id, draftId });
    if (!draft) return res.status(404).json({ error: 'workspace app draft not found' });
    const publish = applyWorkspaceAppDraftPublish({
      projectRoot: project.rootPath,
      definition,
      draft,
      actorUserId: userId!,
      confirmed,
      expectedBeforeHash,
      previewHash,
    });
    res.json({ publish });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to publish workspace app draft' });
  }
});

router.post('/:appId/drafts', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const appId = String(req.params.appId || '').trim();
    if (!projectId || !appId) return res.status(400).json({ error: 'projectId and appId are required' });
    if (!(await canManageProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project app management denied' });

    const project = await getProject(projectId);
    if (!project?.rootPath) return res.status(404).json({ error: 'project not found' });
    const definition = resolveDefinition(project.rootPath, appId);
    if (!definition) return res.status(404).json({ error: 'workspace app definition not found' });
    const draftPreview = WorkspaceAppBuilderDraftPreviewSchema.parse(req.body?.draftPreview);
    const draft = saveWorkspaceAppDraft({ projectRoot: project.rootPath, projectId, definition, actorUserId: userId!, draftPreview });
    res.status(201).json({ draft });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to save workspace app draft' });
  }
});

router.post('/:appId/actions/:actionId', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const appId = String(req.params.appId || '').trim();
    const actionId = String(req.params.actionId || '').trim();
    if (!projectId || !appId || !actionId) return res.status(400).json({ error: 'projectId, appId and actionId are required' });
    if (!(await canManageProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project app action denied' });

    const project = await getProject(projectId);
    if (!project?.rootPath) return res.status(404).json({ error: 'project not found' });
    const definition = resolveDefinition(project.rootPath, appId);
    if (!definition) return res.status(404).json({ error: 'workspace app definition not found' });
    const payload = WorkspaceAppActionPayloadSchema.parse(req.body?.payload ?? {});
    const receipt = await executeWorkspaceAppAction({
      projectRoot: project.rootPath,
      projectId,
      definition,
      actionId,
      actorUserId: userId!,
      payload,
    });
    res.status(201).json({ receipt });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to execute workspace app action' });
  }
});

router.post('/:appId/query', async (req, res) => {
  try {
    if (!config.workspaceAppsEnabled) return res.status(404).json({ error: 'workspace apps beta is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role as string | undefined;
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const queryId = typeof req.body?.queryId === 'string' ? req.body.queryId.trim() : '';
    const appId = String(req.params.appId || '').trim();
    if (!projectId || !queryId || !appId) return res.status(400).json({ error: 'projectId, appId and queryId are required' });
    if (!(await canReadProjectApps(projectId, userId, role))) return res.status(403).json({ error: 'project access denied' });

    const project = await getProject(projectId);
    if (!project?.rootPath) return res.status(404).json({ error: 'project not found' });
    const definition = resolveDefinition(project.rootPath, appId);
    if (!definition) return res.status(404).json({ error: 'workspace app definition not found' });
    const query = findWorkspaceAppReadQuery(definition, queryId);
    if (definition.source?.provider === 'sqlite') {
      if (!definition.source.databasePath) return res.status(400).json({ error: 'workspace app has no SQLite databasePath configured' });
      const result = await runWorkspaceAppSqliteReadOnlyQuery({ projectRoot: project.rootPath, databasePath: definition.source.databasePath, sql: query.sql });
      return res.json({ appId: definition.id, queryId: query.id, provider: 'sqlite', ...result });
    }
    if (definition.source?.provider === 'neon') {
      if (!definition.source.connectionId) return res.status(400).json({ error: 'workspace app has no Neon connection configured' });
      const resolved = await resolveProjectCredentialSecretValue({
        projectId,
        userId: userId!,
        credentialId: definition.source.connectionId,
        provider: 'neon',
        targetType: 'workspace_apps_query',
      });
      if (!resolved?.value) return res.status(403).json({ error: 'Neon connection is not available to this project' });

      const result = await runWorkspaceAppReadOnlyQuery({ connectionString: resolved.value, sql: query.sql });
      return res.json({ appId: definition.id, queryId: query.id, provider: 'neon', ...result });
    }
    return res.status(400).json({ error: 'workspace app has no live data source configured' });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'failed to run workspace app query' });
  }
});

export default router;
