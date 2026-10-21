// @vitest-environment jsdom
import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {DashboardList} from './DashboardList';
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
afterEach(()=>{cleanup();vi.unstubAllGlobals()});
const entry=(name:string,path:string,isDirectory=true)=>({name,path,isDirectory});
it('opens saved dashboard through the existing file callback',async()=>{const fetcher=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({entries:[entry('dashboards','/p/dashboards')]})}).mockResolvedValueOnce({ok:true,json:async()=>({entries:[entry('pricing','/p/dashboards/pricing')]})}).mockResolvedValueOnce({ok:true,json:async()=>({entries:[entry('dashboard.pricing-app.json','/p/dashboards/pricing/dashboard.pricing-app.json',false)]})});vi.stubGlobal('fetch',fetcher);const open=vi.fn();render(<DashboardList rootPath="/p" onOpen={open}/>);expect(fetcher).not.toHaveBeenCalled();fireEvent.click(screen.getByText('dashboardList.title'));fireEvent.click(await screen.findByText('pricing'));expect(open.mock.calls[0][0].path).toBe('/p/dashboards/pricing/dashboard.pricing-app.json')});
it('shows empty without creating directories',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({entries:[]})}));render(<DashboardList rootPath="/p" onOpen={vi.fn()}/>);fireEvent.click(screen.getByText('dashboardList.title'));expect(await screen.findByText('dashboardList.empty')).toBeTruthy()});
it('distinguishes permission failure from an empty list',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:403}));render(<DashboardList rootPath="/p" onOpen={vi.fn()}/>);fireEvent.click(screen.getByText('dashboardList.title'));expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByText('dashboardList.empty')).toBeNull()});
