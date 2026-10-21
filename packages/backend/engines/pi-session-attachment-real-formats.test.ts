import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, vi, afterEach } from 'vitest';
const auth = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../services/agent-workspaces/team-context.js', () => ({ resolveTeamAgentContext: vi.fn(async () => null) }));
vi.mock('../services/session-attachments/session-attachment-store.js', () => ({ resolveAuthorizedSessionAttachment: auth.resolve }));
import { createPdfAwareReadTool } from './pi-pdf-aware-read-tool.js';
import { createPdfViewTool } from './pi-pdf-view-tool.js';
import { createExcelReadTool, createExcelQueryTool } from './pi-finance-tools.js';
import { createExcelDiffTool, createPdfReadTool } from './pi-finance-tools-extra.js';
import { createCadViewTool } from './pi-cad-view-tool.js';
const roots: string[] = [];
afterEach(async () => { auth.resolve.mockReset(); await Promise.all(roots.splice(0).map(p=>fs.rm(p,{recursive:true,force:true}))); });
const body=(result:any)=>result.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');

describe('real format parsers consume ephemeral shared-session capabilities', () => {
  it('reads TXT/image/PDF/XLSX/CSV/DXF without source promotion; real parsers, synthetic authorized source', async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'tower-real-attachment-'));roots.push(root);
    execFileSync('python3',['-c',`
import os,sys,fitz,openpyxl,ezdxf
from PIL import Image
r=sys.argv[1]
open(os.path.join(r,'source.txt'),'w').write('first\\nattachment nonce 1842\\nlast\\n')
open(os.path.join(r,'source.csv'),'w').write('item,value\\na,17\\nb,23\\n')
Image.new('RGB',(200,100),'white').save(os.path.join(r,'source.png'))
d=fitz.open();p=d.new_page();p.insert_text((72,72),'Attachment nonce 1842');d.save(os.path.join(r,'source.pdf'));d.close()
w=openpyxl.Workbook();s=w.active;s.append(['item','value']);s.append(['a',17]);s.append(['b',23]);w.save(os.path.join(r,'source.xlsx'))
d=ezdxf.new();d.modelspace().add_line((0,0),(100,60));d.modelspace().add_text('CANARY 1842',dxfattribs={'height':8});d.saveas(os.path.join(r,'source.dxf'))
`,root],{timeout:30000});
    const initial=(await fs.readdir(root)).sort();
    auth.resolve.mockImplementation(async (_uid:number,_sid:string,uri:string)=>{
      const ext=uri.split('/').at(-1)!; if(!['txt','csv','png','pdf','xlsx','dxf'].includes(ext))throw new Error('invalid test URI');
      return {path:path.join(root,'source.'+ext),document:{name:'source.'+ext}};
    });
    const projectSource={stat:vi.fn(()=>{throw new Error('unexpected Project stat');}),readProbe:vi.fn(),readFile:vi.fn()};
    const ctx={cwd:root,projectRoot:path.join(root,'unrelated-project'),projectSource,userId:8,sessionId:'shared-reader'};
    const invoke=(tool:any,params:any)=>tool.execute('test',params,new AbortController().signal);
    const txt=await invoke(createPdfAwareReadTool(ctx),{path:'session://attachments/txt',offset:2,limit:1});expect(body(txt)).toContain('1842');
    const image=await invoke(createPdfAwareReadTool(ctx),{path:'session://attachments/png'});expect(image.content.some((c:any)=>c.type==='image')).toBe(true);
    const pdf=await invoke(createPdfViewTool(ctx),{path:'session://attachments/pdf',pages:'1',dpi:72});expect(pdf.isError).not.toBe(true);expect(pdf.details.coverage.deliveredPages).toEqual([1]);
    const tables=await invoke(createPdfReadTool(ctx),{path:'session://attachments/pdf',pages:'1'});expect(body(tables)).not.toContain('failed:');expect(body(tables)).toContain('1 pages');
    const excel=await invoke(createExcelReadTool(ctx),{path:'session://attachments/xlsx'});expect(body(excel)).toContain('17');expect(body(excel)).not.toContain('failed:');
    const query=await invoke(createExcelQueryTool(ctx),{path:'session://attachments/csv',query:'df["value"].sum()'});expect(body(query)).toContain('40');
    const diff=await invoke(createExcelDiffTool(ctx),{files:['session://attachments/csv','session://attachments/xlsx']});expect(body(diff)).not.toContain('failed:');
    const cad=await invoke(createCadViewTool(ctx),{path:'session://attachments/dxf',width:600,height:600});expect(cad.isError).not.toBe(true);expect(cad.content.some((c:any)=>c.type==='image')).toBe(true);
    expect(projectSource.stat).not.toHaveBeenCalled();expect(projectSource.readFile).not.toHaveBeenCalled();
    expect((await fs.readdir(root)).sort()).toEqual(initial);expect(auth.resolve.mock.calls.every(c=>c[0]===8&&c[1]==='shared-reader')).toBe(true);
  },120000);
});
