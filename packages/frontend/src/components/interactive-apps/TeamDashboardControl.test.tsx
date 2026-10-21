// @vitest-environment jsdom
import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import {TeamDashboardControl,parseControlRegistry} from './TeamDashboardControl';
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(s:string)=>s})}));
afterEach(()=>{cleanup();vi.unstubAllGlobals()});
it('rejects path escape and duplicate slots',()=>{expect(()=>parseControlRegistry({version:1,dashboards:[{slug:'../x',title:'x'}]})).toThrow();expect(()=>parseControlRegistry({version:1,dashboards:[{slug:'a',title:'a'},{slug:'a',title:'b'}]})).toThrow()});
it('parses explicit entries only',()=>expect(parseControlRegistry({version:1,dashboards:[{slug:'sales',title:'Sales'}]})).toEqual([{slug:'sales',title:'Sales'}]));
it('does not register ordinary files automatically',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({entries:[]})}));render(<TeamDashboardControl projects={[{id:'p',name:'Owner',rootPath:'/p'} as any]}/>);expect(await screen.findByText('teamControl.empty')).toBeTruthy()});
it('reports permission failures',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:403}));render(<TeamDashboardControl projects={[{id:'p',name:'Owner',rootPath:'/p'} as any]}/>);expect(await screen.findByRole('alert')).toBeTruthy()});
it('supports explicitly registered self-contained HTML without requiring a database',()=>expect(parseControlRegistry({version:1,dashboards:[{slug:'business-demo',title:'Demo',format:'html',entry:'site/index.html'}]})).toEqual([{slug:'business-demo',title:'Demo',format:'html',entry:'site/index.html'}]));
it.each(['../index.html','site/../private.html','https://example.com/index.html','site/data.sqlite3','/site/index.html'])('rejects unsafe HTML entry %s',entry=>expect(()=>parseControlRegistry({version:1,dashboards:[{slug:'demo',title:'Demo',format:'html',entry}]})).toThrow());
