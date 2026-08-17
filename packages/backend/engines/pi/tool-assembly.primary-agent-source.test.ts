import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const source=fs.readFileSync(path.resolve(import.meta.dirname,'./tool-assembly.ts'),'utf8');
describe('Primary Agent creation surface',()=>{
  it('exposes the guarded creation tool alongside discovery and preview tools',()=>{
    expect(source).toContain('const primaryAgentProjectTool = createPrimaryAgentProjectTool(primaryAgentToolContext)');
    expect(source).toContain('...(primaryAgentProjectTool ? [primaryAgentProjectTool] : [])');
    expect(source).toContain('createPrimaryAgentStaffingTools');
    expect(source).toContain('createPrimaryAgentProfileTools');
    expect(source).not.toContain('const primaryAgentProjectTool = null');
  });
});
