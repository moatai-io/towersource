export interface LinearIssueSnapshot {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  teamKey: string;
  projectId: string | null;
  assigneeId: string | null;
  labels: string[];
}

const ENDPOINT = 'https://api.linear.app/graphql';

export class LinearIssueUnavailableError extends Error {
  constructor() { super('linear_issue_unavailable'); this.name = 'LinearIssueUnavailableError'; }
}

function issueUnavailable(errors: unknown): boolean {
  return Array.isArray(errors) && errors.some((error: any) => error?.message === 'Entity not found: Issue'
    && error?.extensions?.code === 'INPUT_ERROR');
}

export async function fetchLinearIssue(issueId: string, apiKey: string, fetcher: typeof fetch = fetch): Promise<LinearIssueSnapshot> {
  if (!apiKey) throw new Error('linear_api_key_missing');
  const query = `query LinearWebhookIssue($id:String!){issue(id:$id){id identifier title description url team{key} project{id} assignee{id} labels{nodes{name}}}}`;
  const response = await fetcher(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: apiKey },
    body: JSON.stringify({ query, variables: { id: issueId } }),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`linear_http_${response.status}`);
  const body = await response.json() as any;
  if (issueUnavailable(body.errors)) throw new LinearIssueUnavailableError();
  if (Array.isArray(body.errors) && body.errors.length) throw new Error('linear_graphql_error');
  const issue = body.data?.issue;
  if (!issue?.id || !issue?.team?.key) throw new LinearIssueUnavailableError();
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description || '',
    url: issue.url,
    teamKey: issue.team.key,
    projectId: issue.project?.id || null,
    assigneeId: issue.assignee?.id || null,
    labels: (issue.labels?.nodes || []).map((label: any) => label.name).filter(Boolean),
  };
}
