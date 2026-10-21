import {it,expect,vi,beforeEach} from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn(),cas:vi.fn()}));
vi.mock('../project-environment/project-workspace-files.js',()=>({readProjectWorkspaceFileBytes:m.read,compareAndSwapProjectWorkspaceText:m.cas}));
import {addRegisteredDashboard} from './control-room-registration';
beforeEach(()=>{vi.clearAllMocks();m.read.mockResolvedValue({bytes:Buffer.from('{"version":1,"dashboards":[]}')});m.cas.mockResolvedValue(undefined)});
it('writes with exact content precondition',async()=>{await addRegisteredDashboard({} as any,1,{slug:'demo',title:'Demo'});expect(m.cas.mock.calls[0][0].expectedContent).toBe('{"version":1,"dashboards":[]}')});
it('propagates concurrent edits without retrying blind overwrite',async()=>{m.cas.mockRejectedValue(Error('conflict'));await expect(addRegisteredDashboard({} as any,1,{slug:'demo',title:'Demo'})).rejects.toThrow('conflict');expect(m.cas).toHaveBeenCalledTimes(1)});
it('does not write identical registration',async()=>{m.read.mockResolvedValue({bytes:Buffer.from('{"version":1,"dashboards":[{"slug":"demo","title":"Demo"}]}')});expect(await addRegisteredDashboard({} as any,1,{slug:'demo',title:'Demo'})).toEqual({changed:false});expect(m.cas).not.toHaveBeenCalled()});
