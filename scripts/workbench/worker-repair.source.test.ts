import fs from 'node:fs';import path from 'node:path';import {describe,expect,it} from 'vitest';
const root=path.resolve(import.meta.dirname,'../..');const script=fs.readFileSync(path.join(root,'scripts/workbench/worker-repair'),'utf8');const start=fs.readFileSync(path.join(root,'start.sh'),'utf8');
describe('External Worker repair source contract',()=>{
 it('exposes only named component repair and reruns Doctor',()=>{expect(start).toContain('worker-repair)');expect(script).toContain('--tunnel|--heartbeat|--worker');expect(script).toContain('intentionally unsupported');expect(script).toContain('worker-doctor.ts')});
 it('does not mutate Worker authority or replay jobs',()=>{expect(script).not.toMatch(/rotateWorkbench|configureWorkbench|replay|--all\)/);expect(script).toContain('docker restart');expect(script).toContain('systemctl --user restart')});
});
