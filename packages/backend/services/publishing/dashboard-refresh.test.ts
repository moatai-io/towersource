import { beforeEach, describe, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({membership:vi.fn(),get:vi.fn(),access:vi.fn(),run:vi.fn()}));
vi.mock('../pm/project-membership-manager.js',()=>({getProjectMembershipIds:m.membership}));
vi.mock('../task/automation-manager.js',()=>({getAutomation:m.get}));
vi.mock('../task/schedule-permissions.js',()=>({canAccessAutomationJob:m.access}));
vi.mock('../task/automation-control.js',()=>({runAutomationNow:m.run}));
import {requestDashboardRefresh} from './dashboard-refresh';
const binding={publicationId:'pub',ownerProjectId:'p',automationId:'a'}, actor={userId:1,role:'member'};
beforeEach(()=>{vi.clearAllMocks();m.membership.mockResolvedValue(['p']);m.get.mockResolvedValue({id:'a',projectId:'p',status:'idle'});m.access.mockResolvedValue({allowed:true});m.run.mockResolvedValue({runId:'r',status:'success',stdoutText:'private output'})});
describe('dashboard refresh adapter',()=>{
 it('requires explicit confirmation before lookup',async()=>{await expect(requestDashboardRefresh(binding,actor,false)).rejects.toThrow('confirmation_required');expect(m.get).not.toHaveBeenCalled()});
 it('cannot use privileged roles to bypass membership',async()=>{m.membership.mockResolvedValue([]);await expect(requestDashboardRefresh(binding,{...actor,role:'admin'},true)).rejects.toThrow('forbidden');expect(m.run).not.toHaveBeenCalled()});
 it('rejects cross Project jobs',async()=>{m.get.mockResolvedValue({projectId:'other'});await expect(requestDashboardRefresh(binding,actor,true)).rejects.toThrow('unavailable');expect(m.run).not.toHaveBeenCalled()});
 it('rejects archived jobs',async()=>{m.get.mockResolvedValue({projectId:'p',status:'archived'});await expect(requestDashboardRefresh(binding,actor,true)).rejects.toThrow('unavailable')});
 it('requires automation run authority beyond viewing',async()=>{m.access.mockResolvedValue({allowed:false});await expect(requestDashboardRefresh(binding,actor,true)).rejects.toThrow('forbidden');expect(m.run).not.toHaveBeenCalled()});
 it('delegates execution to existing control plane and strips output',async()=>{expect(await requestDashboardRefresh(binding,actor,true)).toEqual({publicationId:'pub',automationId:'a',runId:'r',status:'success'});expect(m.run).toHaveBeenCalledTimes(1)});
});
