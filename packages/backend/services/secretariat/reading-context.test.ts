import {beforeEach,expect,it,vi} from 'vitest';
vi.mock('../pm/project-access.js',()=>({canAccessSession:vi.fn()}));
vi.mock('../pm/project-membership-manager.js',()=>({isProjectMember:vi.fn()}));
vi.mock('./store.js',()=>({secretariatStore:{candidates:vi.fn(),context:vi.fn()}}));
vi.mock('./provider.js',()=>({safeCandidate:()=>true}));
import {canAccessSession} from '../pm/project-access.js';import {isProjectMember} from '../pm/project-membership-manager.js';import {secretariatStore} from './store.js';import {readParticipatingContext} from './reading-context.js';
beforeEach(()=>{vi.resetAllMocks();vi.mocked(isProjectMember).mockResolvedValue(true);vi.mocked(canAccessSession).mockResolvedValue({allowed:true});vi.mocked(secretariatStore.candidates).mockResolvedValue([{projectId:'p',sessionId:'s',title:'title',updatedAt:'now'}] as any);vi.mocked(secretariatStore.context).mockResolvedValue([{role:'user',text:'source'}]);});
it('reuses participating candidates including previously proposed sources',async()=>{expect(await readParticipatingContext(7)).toHaveLength(1);expect(secretariatStore.candidates).toHaveBeenCalledWith(7,true);});
it('denies source before reading when session permission is lost',async()=>{vi.mocked(canAccessSession).mockResolvedValue({allowed:false,status:403,message:'denied'});expect(await readParticipatingContext(7)).toEqual([]);expect(secretariatStore.context).not.toHaveBeenCalled();});
