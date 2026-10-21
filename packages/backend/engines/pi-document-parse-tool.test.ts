import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), prepare: vi.fn(), reference: vi.fn(), write: vi.fn() }));
vi.mock('../services/content-safety/file-representation-gateway.js', async (original) => ({
  ...(await original<typeof import('../services/content-safety/file-representation-gateway.js')>()),
  prepareFileRepresentation: mocks.prepare,
  readPreparedFileBytes: async (prepared: any) => fs.readFile(prepared.path),
}));
vi.mock('../services/project-environment/project-workspace-files.js', () => ({ resolveProjectWorkspaceFile: mocks.reference, writeProjectWorkspaceText: mocks.write }));
vi.mock('../services/credential-vault/credential-vault-service.js', () => ({
  resolveProjectApiKeySecretValue: mocks.resolve,
}));

vi.mock('../db/pg-repo.js', () => ({ queryOne: vi.fn(async () => ({ visibility: 'project' })) }));

import { createDocumentParseTool } from './pi-document-parse-tool.js';

describe('document_parse', () => {
  let root: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    mocks.reference.mockImplementation(async ({ projectRoot, relativePath }) => ({ hostPath: path.join(projectRoot, relativePath) }));
    mocks.write.mockImplementation(async ({ reference, content }) => {
      await fs.mkdir(path.dirname(reference.hostPath), { recursive: true });
      await fs.writeFile(reference.hostPath, content, { flag: 'wx' });
    });
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-document-parse-'));
    vi.stubEnv('ZUPLO_VIRTUAL_KEY', 'synthetic-virtual-key');
    vi.stubEnv('COREPIN_API_BASE_URL', 'https://gateway.example.com/corepin');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('uploads a supported Project file and writes only the Markdown body', async () => {
    await fs.writeFile(path.join(root, 'sample.hwp'), 'synthetic document');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      markdown: '# 변환 결과\n',
      meta: {
        model_id: 'doc', model_version: 'doc-test', request_id: 'req-test',
        page_count: 1, file_format: 'hwp', ocr_pages_used: 0, warnings: [],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const tool = createDocumentParseTool({ cwd: root, projectRoot: root, projectId: 'project-1', userId: 1 });
    const result = await tool.execute!('call-1', { path: 'sample.hwp', output_path: 'parsed/sample.md' });

    expect(result.isError).not.toBe(true);
    expect(await fs.readFile(path.join(root, 'parsed/sample.md'), 'utf8')).toBe('# 변환 결과\n');
    expect(result.content[0].text).toContain('parsed/sample.md');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.example.com/corepin/v1/doc/parse');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer synthetic-virtual-key');
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('parses a session attachment without persisting the source and uses Project authority for output', async () => {
    const temporary = path.join(root, 'temporary.hwp');
    await fs.writeFile(temporary, Buffer.from([0xd0,0xcf,0x11,0xe0]));
    const uri = 'session://attachments/11111111-1111-4111-8111-111111111111';
    mocks.prepare.mockResolvedValue({ path: temporary, name: 'temporary.hwp', sizeBytes: 4, temporary: true });
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ markdown: '# converted' }) })) as any;
    const tool = createDocumentParseTool({ cwd: root, projectRoot: root, projectId: 'project-1', userId: 1, sessionId: 's1' });
    const result: any = await tool.execute!('call-attachment', { path: uri });
    expect(result.isError).not.toBe(true);
    expect(mocks.prepare).toHaveBeenCalledWith(uri, expect.objectContaining({ sessionId: 's1', userId: 1 }));
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 1, exclusive: true }));
    expect(await fs.readFile(path.join(root, 'work/temporary.md'), 'utf8')).toBe('# converted');
    expect(await fs.readFile(temporary)).toEqual(Buffer.from([0xd0,0xcf,0x11,0xe0]));
  });

  it('never contacts the parser when attachment authorization fails', async () => {
    mocks.prepare.mockRejectedValue(new Error('Session attachment access denied'));
    global.fetch = vi.fn();
    const tool = createDocumentParseTool({ cwd: root, projectRoot: root, projectId: 'project-1', userId: 1, sessionId: 's1' });
    const result: any = await tool.execute!('denied', { path: 'session://attachments/11111111-1111-4111-8111-111111111111' });
    expect(result.isError).toBe(true); expect(global.fetch).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  });

  it('rejects source and output paths outside the current Project', async () => {
    const tool = createDocumentParseTool({ cwd: root, projectRoot: root, projectId: 'project-1', userId: 1 });
    const sourceResult = await tool.execute!('call-2', { path: '../secret.hwp', output_path: 'out.md' });
    expect(sourceResult.isError).toBe(true);
    expect(sourceResult.content[0].text).toContain('only accepts paths inside the current Project');

    await fs.writeFile(path.join(root, 'sample.hwp'), 'synthetic document');
    const outputResult = await tool.execute!('call-3', { path: 'sample.hwp', output_path: '../out.md' });
    expect(outputResult.isError).toBe(true);
  });

  it('does not overwrite an existing Markdown file', async () => {
    await fs.writeFile(path.join(root, 'sample.txt'), 'hello');
    await fs.writeFile(path.join(root, 'sample.md'), 'keep');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      markdown: '# replacement', meta: { request_id: 'req-test' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const tool = createDocumentParseTool({ cwd: root, projectRoot: root, projectId: 'project-1', userId: 1 });
    const result = await tool.execute!('call-4', { path: 'sample.txt' });
    expect(result.isError).toBe(true);
    expect(await fs.readFile(path.join(root, 'sample.md'), 'utf8')).toBe('keep');
  });

  it('returns bounded provider errors without leaking upstream messages', async () => {
    await fs.writeFile(path.join(root, 'sample.pdf'), 'not a real pdf');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'invalid_request', message: 'sensitive detail', request_id: 'req-safe' },
    }), { status: 422, headers: { 'content-type': 'application/json' } }));

    const tool = createDocumentParseTool({ cwd: root, projectRoot: root, projectId: 'project-1', userId: 1 });
    const result = await tool.execute!('call-5', { path: 'sample.pdf', output_path: 'sample-parsed.md' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('code=invalid_request');
    expect(result.content[0].text).toContain('request_id=req-safe');
    expect(result.content[0].text).not.toContain('sensitive detail');
  });
});

it('allows private output through normal source validation', async () => {
  const privacy = await import('../services/session/session-artifact-privacy.js');
  const guard = vi.spyOn(privacy, 'assertSessionAllowsSharedArtifactWrite').mockResolvedValue(undefined);
  try {
    const tool = createDocumentParseTool({ cwd: '/project', projectRoot: '/project', projectId: 'p', userId: 1, sessionId: 'private' });
    const result: any = await tool.execute('t', { path: 'session://attachments/11111111-1111-4111-8111-111111111111/test.pdf' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Private session');
    expect(guard).toHaveBeenCalledWith('private');
  } finally { guard.mockRestore(); }
});
