// @vitest-environment jsdom
import React from 'react';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({confirm:vi.fn(),run:vi.fn()}));
vi.mock('../../hooks/useDialog',()=>({useConfirm:()=>mocks.confirm}));
vi.mock('./browser-file-canary',()=>({runBrowserFileCanary:mocks.run}));
import { BrowserFileCanaryButton } from './BrowserFileCanaryButton';
afterEach(()=>{cleanup();vi.clearAllMocks();vi.unstubAllGlobals();});
it('does nothing when confirmation is cancelled',async()=>{
 mocks.confirm.mockResolvedValue(false);const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 render(<BrowserFileCanaryButton projectId="p" name="Example" />);fireEvent.click(screen.getByRole('button'));
 await waitFor(()=>expect(mocks.confirm).toHaveBeenCalled());expect(fetcher).not.toHaveBeenCalled();expect(mocks.run).not.toHaveBeenCalled();
});
it('uses current browser identity and displays limited scope and retained path',async()=>{
 mocks.confirm.mockResolvedValue(true);const fetcher=vi.fn(async()=>({ok:true,json:async()=>[{id:'p',rootPath:'/project'}]}));vi.stubGlobal('fetch',fetcher);
 mocks.run.mockResolvedValue({status:'PASS',retained:true,path:'/project/probe.txt'});
 render(<BrowserFileCanaryButton projectId="p" name="Example" token="synthetic" />);fireEvent.click(screen.getByRole('button'));
 await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('Worker·Viewer는 미검증'));
 expect(fetcher.mock.calls[0][0]).toBe('/api/projects');expect(mocks.run).toHaveBeenCalledWith('/project',expect.any(Function));
 expect(screen.getByRole('status').textContent).toContain('/project/probe.txt');
});
it('blocks missing Project without running canary',async()=>{
 mocks.confirm.mockResolvedValue(true);vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>[]})));
 render(<BrowserFileCanaryButton projectId="p" name="Example" />);fireEvent.click(screen.getByRole('button'));
 await screen.findByRole('alert');expect(mocks.run).not.toHaveBeenCalled();
});
it('prevents duplicate runs while confirmation is still pending',async()=>{
 let resolve!: (value:boolean)=>void;
 mocks.confirm.mockImplementation(()=>new Promise<boolean>(r=>{resolve=r;}));
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 render(<BrowserFileCanaryButton projectId="p" name="Example" />);
 fireEvent.click(screen.getByRole('button'));fireEvent.click(screen.getByRole('button'));
 expect(mocks.confirm).toHaveBeenCalledTimes(1);resolve(false);
 await waitFor(()=>expect(fetcher).not.toHaveBeenCalled());
});
