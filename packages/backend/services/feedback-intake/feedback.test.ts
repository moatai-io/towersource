import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { clientConfig, clientEnabled, deliveryEnabled, githubConfig, intakeEnabled } from './config.js';
import { assertNoSecrets, FeedbackError, submissionSchema, tokenDigest, type Delivery, type IntakeStore } from './contract.js';
import { closureSubmission, defaultSubmissionKey, FeedbackClient, formatReceipt } from './client.js';
import { appJwt, DeliveryFailure, GitHubAppDelivery, githubIssue } from './github-app.js';
import { deliverOne } from './delivery.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { appId: '123', installationId: '456', repositoryId: 789, repository: 'example-org/tower-issues',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
const ctx = { userId: 7, username: 'Reporter', sessionId: 'session-a', projectId: 'project-a' };
const args = { title: 'Feedback', body: 'Repro steps' };
const payload = closureSubmission(ctx, args);
const id = '8214b39a-a689-4f8b-b72a-ac82e93519f7';
const delivery: Delivery = { id, tenant: { id: 'customer-a', titlePrefix: 'Customer A', label: 'customer:customer-a' },
  payload, attempts: 1, claimId: 'claim-a' };
const json = (value: object, status = 200) => new Response(JSON.stringify(value), { status });
function responses(...values: Array<Response | Error>) {
  return vi.fn(async () => { const value = values.shift(); if (value instanceof Error) throw value; if (!value) throw new Error('unexpected request'); return value; });
}
const installation = () => json({ token: 'synthetic-installation-token', permissions: { issues: 'write', metadata: 'read' } });
const repo = (patch = {}) => json({ id: 789, full_name: config.repository, visibility: 'private', private: true, ...patch });

describe('central feedback boundaries', () => {
  it('activation defaults off, passive candidate never delivers', () => {
    expect(clientEnabled({})).toBe(false); expect(intakeEnabled({})).toBe(false); expect(deliveryEnabled({})).toBe(false);
    expect(deliveryEnabled({ TOWER_FEEDBACK_INTAKE_ENABLED: 'true', TOWER_FEEDBACK_DELIVERY_ENABLED: 'true', TOWER_CANDIDATE_PASSIVE_MODE: 'true' })).toBe(false);
  });
  it('strict contracts reject tenant, repo, label and reporter overrides', () => {
    for (const extra of [{ customerId: 'customer-b' }, { repo: 'other/repo' }, { labels: ['admin'] }]) {
      expect(submissionSchema.safeParse({ ...payload, ...extra }).success).toBe(false);
    }
    expect(() => closureSubmission(ctx, { ...args, repo: 'other/repo' })).toThrow('override');
    expect(() => closureSubmission(ctx, { ...args, allowPublicRepo: true })).toThrow('override');
    expect(closureSubmission(ctx, { ...args, reporter: { userId: 999 } } as any).reporter.userId).toBe(7);
  });
  it('deterministic keys survive retries but separate users and sessions', () => {
    expect(defaultSubmissionKey(payload)).toBe(defaultSubmissionKey(closureSubmission(ctx, args)));
    expect(defaultSubmissionKey(payload)).not.toBe(defaultSubmissionKey(closureSubmission({ ...ctx, userId: 8 }, args)));
    expect(defaultSubmissionKey(payload)).not.toBe(defaultSubmissionKey(closureSubmission({ ...ctx, sessionId: 'other' }, args)));
  });
  it('hashes credentials with domain separation; never stores plaintext', () => {
    expect(tokenDigest('synthetic-token')).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenDigest('synthetic-token')).not.toContain('synthetic-token');
  });
  it.each(['github_pat_' + 'a'.repeat(30), 'sk-' + 'a'.repeat(30), '-----BEGIN RSA PRIVATE KEY-----'])('rejects secret patterns', value => {
    expect(() => assertNoSecrets({ ...payload, body: value })).toThrow(FeedbackError);
  });
  it('refuses non-HTTPS and credential-bearing origin, paths and queries', () => {
    for (const origin of ['http://app.localhost', 'https://user:pass@app.localhost', 'https://app.localhost/path', 'https://app.localhost/?key=1']) {
      expect(() => clientConfig({ TOWER_FEEDBACK_INTAKE_ORIGIN: origin, TOWER_FEEDBACK_CLIENT_TOKEN: 'a'.repeat(43) })).toThrow();
    }
    expect(clientConfig({ TOWER_FEEDBACK_INTAKE_ORIGIN: 'https://feedback.example.com', TOWER_FEEDBACK_CLIENT_TOKEN: 'a'.repeat(43) }).origin).toBe('https://feedback.example.com');
  });
  it('validates GitHub App configuration without exposing the key', () => {
    expect(() => githubConfig({})).toThrow('feedback_github_not_configured');
    expect(githubConfig({ TOWER_FEEDBACK_GITHUB_APP_ID: '123', TOWER_FEEDBACK_GITHUB_INSTALLATION_ID: '456',
      TOWER_FEEDBACK_GITHUB_REPOSITORY_ID: '789', TOWER_FEEDBACK_GITHUB_REPOSITORY: config.repository,
      TOWER_FEEDBACK_GITHUB_PRIVATE_KEY: config.privateKey }).repositoryId).toBe(789);
  });
  it('uses backend identity with no host/CWD footer and server-managed prefix/labels', () => {
    const issue = githubIssue(delivery);
    expect(issue.title).toBe('[Customer A] Feedback'); expect(issue.labels).toEqual(['from:tower-feedback', 'customer:customer-a']);
    expect(issue.body).toContain('Reporter'); expect(issue.body).toContain(`tower-feedback:${id}`);
    expect(issue.body).not.toMatch(/VM:|CWD:|hostname/);
  });
  it('signs RS256 JWT with a bounded lifetime', () => {
    const jwt = appJwt(config, 1_700_000_000_000); const [header, claims, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({ iat: 1699999940, exp: 1700000540, iss: '123' });
    expect(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature, 'base64url')).toBe(true);
  });
  it('makes fixed-origin nonredirecting requests with narrowed installation permissions', async () => {
    const fetcher = responses(installation(), repo(), json({ number: 4, html_url: 'https://evil.example/' }, 201));
    const result = await new GitHubAppDelivery(config, fetcher as typeof fetch).send(delivery);
    expect(result.issueUrl).toBe('https://github.com/example-org/tower-issues/issues/4');
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls.every(([url, init]) => url.startsWith('https://api.github.com/') && init.redirect === 'error')).toBe(true);
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ repository_ids: [789], permissions: { issues: 'write', metadata: 'read' } });
  });
  it.each([{ private: false }, { visibility: 'internal' }, { id: 800 }, { full_name: 'other/repo' }])('blocks mismatched/private repository before create', async patch => {
    const fetcher = responses(installation(), repo(patch));
    await expect(new GitHubAppDelivery(config, fetcher as typeof fetch).send(delivery)).rejects.toMatchObject({ disposition: 'failed' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('refuses unexpected installation permissions', async () => {
    const fetcher = responses(json({ token: 'synthetic', permissions: { issues: 'write', contents: 'write' } }));
    await expect(new GitHubAppDelivery(config, fetcher as typeof fetch).send(delivery)).rejects.toThrow('scope_invalid');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([new Error('synthetic private provider detail'), json({ detail: 'private' }, 500), json({}, 202), json({}, 201)])('marks ambiguous create for review', async response => {
    const fetcher = responses(installation(), repo(), response);
    await expect(new GitHubAppDelivery(config, fetcher as typeof fetch).send(delivery)).rejects.toMatchObject({ code: 'github_create_uncertain', disposition: 'review' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('redacts client transport errors and does not auto retry', async () => {
    const fetcher = responses(new Error('authorization=private-synthetic-value'));
    const client = new FeedbackClient({ origin: 'https://feedback.example.com', token: 'synthetic' }, fetcher as typeof fetch);
    await expect(client.submit(ctx, args)).rejects.toThrow('feedback_acceptance_unknown_retry_same_request');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('clearly separates accepted and delivered receipts', () => {
    expect(formatReceipt({ id, status: 'accepted' })).toContain('아직 완료되지');
    expect(formatReceipt({ id, status: 'delivered', issueNumber: 1, issueUrl: 'https://github.com/example-org/tower-issues/issues/1' })).toContain('전송이 완료');
  });
});

describe('durable delivery outcomes', () => {
  function store(attempts = 1) { return { claim: vi.fn(async () => ({ ...delivery, attempts })), settle: vi.fn(async () => {}) } as unknown as IntakeStore; }
  it.each([
    ['retry', 1, 'accepted'], ['retry', 5, 'failed'], ['review', 1, 'needs_review'], ['failed', 1, 'failed'],
  ] as const)('%s at attempt %i settles to %s', async (disposition, attempts, status) => {
    const db = store(attempts);
    await deliverOne(db, { send: async () => { throw new DeliveryFailure('synthetic', disposition); } });
    expect(db.settle).toHaveBeenCalledWith(expect.anything(), { status, code: 'synthetic' });
  });
  it('never requeues a successful create when receipt persistence fails', async () => {
    const db = store(); vi.mocked(db.settle).mockRejectedValue(new Error('db unavailable'));
    const send = vi.fn(async () => ({ issueNumber: 1, issueUrl: 'https://github.com/example-org/tower-issues/issues/1' }));
    await expect(deliverOne(db, { send })).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1); expect(db.settle).toHaveBeenCalledTimes(1);
    expect(db.settle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'delivered' }));
  });
});
