import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), render: vi.fn() }));
vi.mock('../services/session-attachments/session-attachment-store.js', () => ({ resolveAuthorizedSessionAttachment: mocks.resolve }));
vi.mock('./pi-pdf-view-tool.js', () => ({ renderPdfToCachedImages: mocks.render, pdfViewResultContent: vi.fn() }));
vi.mock('./pi-worker-image-read.js', () => ({ readWorkerImage: vi.fn(async () => null) }));
vi.mock('./pi-session-attachment-tool.js', () => ({ readCurrentSessionAttachmentImage: vi.fn() }));
import { createPdfAwareReadTool } from './pi-pdf-aware-read-tool.js';
const roots: string[] = [];
afterEach(async () => { mocks.resolve.mockReset(); mocks.render.mockReset(); await Promise.all(roots.splice(0).map(p => fs.rm(p,{ recursive:true,force:true }))); });
async function setup(content: string, name = 'synthetic.txt') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'tower-session-read-'));roots.push(root);
  const file = path.join(root,name); await fs.writeFile(file,content);
  mocks.resolve.mockResolvedValue({ path:file, document:{ name } });
  const source = { stat:vi.fn(),readProbe:vi.fn(),readFile:vi.fn() };
  const tool = createPdfAwareReadTool({ cwd:root,projectRoot:'/registered/project',projectSource:source,userId:8,sessionId:'shared' });
  return { root,file,source,tool };
}
const text = (result:any) => result.content.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join('\n');
describe('authorized session URI read never uses Project-only operations', () => {
  it.each(['txt','md','csv','json','html'])('reads %s with native line offsets without permanently saving the source', async extension => {
    const { root,source,tool } = await setup('first\n둘째\nthird\n',`synthetic.${extension}`);
    const result = await tool.execute('test',{ path:'session://attachments/test',offset:2,limit:1 },new AbortController().signal);
    expect(text(result)).toContain('둘째');expect(text(result)).not.toContain('first');
    expect(source.stat).not.toHaveBeenCalled();expect(source.readFile).not.toHaveBeenCalled();
    expect(mocks.resolve).toHaveBeenCalledTimes(2);expect(await fs.readdir(root)).toEqual([`synthetic.${extension}`]);
  });
  it.each(['FORBIDDEN','EXPIRED'])('fails closed if access becomes %s after preparation', async code => {
    const { tool } = await setup('synthetic');
    const first = mocks.resolve.getMockImplementation()!;
    mocks.resolve.mockImplementationOnce(first).mockRejectedValue(new Error(code));
    await expect(tool.execute('test',{path:'session://attachments/test'},new AbortController().signal)).rejects.toThrow(code);
  });
  it('keeps opaque input reference-only rather than injecting arbitrary binary', async () => {
    const { tool,file } = await setup('placeholder','synthetic.bin');await fs.writeFile(file,Buffer.from([0,1,2,0,255]));
    const result = await tool.execute('test',{path:'session://attachments/test'},new AbortController().signal);
    expect(text(result)).toContain('not inlined');expect(text(result)).not.toContain(file);
  });
});
