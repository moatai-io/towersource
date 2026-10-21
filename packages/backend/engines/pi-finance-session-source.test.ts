import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), python: vi.fn() }));
vi.mock('../services/session-attachments/session-attachment-store.js', () => ({ resolveAuthorizedSessionAttachment: mocks.resolve }));
vi.mock('child_process', async original => ({ ...(await original<typeof import('node:child_process')>()), execFileSync: mocks.python }));
import { createExcelReadTool, createExcelQueryTool } from './pi-finance-tools.js';
import { createPdfReadTool, createExcelDiffTool } from './pi-finance-tools-extra.js';
const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root,{ recursive:true,force:true }); });
describe('financial parsers use private reauthorized session stages', () => {
  it.each(['excel_read','excel_query','pdf_read','excel_diff'])('%s never passes source host paths to the parser and cleans staging', async name => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'tower-finance-session-'));roots.push(root);
    const file=path.join(root,name==='pdf_read'?'source.pdf':'source.csv');fs.writeFileSync(file,name==='pdf_read'?'%PDF-1.7\nsynthetic':'item,value\na,1\n');
    mocks.resolve.mockResolvedValue({ path:file,document:{ name:path.basename(file) } });
    const staged:string[]=[];
    mocks.python.mockImplementation((command:string,args:string[]) => {
      expect(command).toBe('python3');const script=fs.readFileSync(args[0],'utf8');
      const matches=[...script.matchAll(/"(\/[^"\n]*tower-project-file-stage-[^"\n]+)"/g)];
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) { const p=JSON.parse(`"${m[1]}"`);staged.push(p);expect(p).not.toBe(file);expect(fs.readFileSync(p)).toEqual(fs.readFileSync(file)); }
      if (name==='excel_query') return 'synthetic query result';
      if (name==='pdf_read') return JSON.stringify({file:'source.pdf',total_pages:1,pages_scanned:1,tables_found:0,tables:[]});
      return JSON.stringify({error:'synthetic parser fixture'});
    });
    const ctx={cwd:root,projectRoot:root+'/project',sessionId:'shared',userId:8};
    const tools:any={excel_read:createExcelReadTool(ctx),excel_query:createExcelQueryTool(ctx),pdf_read:createPdfReadTool(ctx),excel_diff:createExcelDiffTool(ctx)};
    await tools[name].execute('test',{path:'session://attachments/test',files:['session://attachments/test','session://attachments/test'],query:'df.shape'});
    expect(mocks.python).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledTimes(name==='excel_diff'?4:2);
    for (const p of staged) expect(fs.existsSync(p)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([path.basename(file)]);
  });
});
