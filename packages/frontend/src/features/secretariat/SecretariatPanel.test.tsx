// @vitest-environment jsdom
import React from 'react';
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {SecretariatPanel} from './SecretariatPanel';
vi.mock('./SecretariatChat',()=>({SecretariatChat:({onBriefing,briefingResult}:any)=><div data-testid="chat"><button onClick={onBriefing}>비서 브리핑</button>{briefingResult&&<p>결과: {briefingResult.id}</p>}</div>}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
const fetchMock=vi.fn();
const snapshot={enabled:false,pausedReason:null,proposals:[]};
const reply=(data:any,ok=true)=>({ok,status:ok?200:503,json:async()=>data});
beforeEach(()=>{vi.resetAllMocks();vi.stubGlobal('fetch',fetchMock);fetchMock.mockResolvedValue(reply(snapshot));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('shows a single conversation and keeps settings behind a menu',async()=>{
 render(<SecretariatPanel/>);await screen.findByTestId('chat');
 expect(screen.queryByText('이전 제안과 읽음 관리')).toBeNull();
 expect(screen.getByRole('switch',{hidden:true}).getAttribute('aria-checked')).toBe('false');
 expect(fetchMock.mock.calls.every(c=>c[1].method==='GET')).toBe(true);
});
it('changes opt-in only when explicitly requested',async()=>{
 render(<SecretariatPanel/>);await waitFor(()=>expect(fetchMock).toHaveBeenCalled());
 fetchMock.mockResolvedValue(reply({...snapshot,enabled:true}));
 fireEvent.click(screen.getByRole('switch',{hidden:true}));
 await waitFor(()=>expect(screen.getByRole('switch',{hidden:true}).getAttribute('aria-checked')).toBe('true'));
 expect(fetchMock).toHaveBeenCalledWith('/api/secretariat',expect.objectContaining({method:'PATCH'}));
});
it('routes an existing briefing to the conversation rather than a second list',async()=>{
 render(<SecretariatPanel/>);await waitFor(()=>expect(fetchMock).toHaveBeenCalled());
 fetchMock.mockResolvedValueOnce(reply({status:'existing',proposalId:'p'})).mockResolvedValue(reply(snapshot));
 fireEvent.click(screen.getByText('비서 브리핑'));
 await screen.findByText('결과: p');
});
