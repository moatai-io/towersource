// @vitest-environment jsdom
import React from 'react';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
vi.mock('../../components/chat/MessageBubble',()=>({MessageBubble:({message}:any)=><div>{message.content[0].text}</div>}));
import {SecretariatChat} from './SecretariatChat';
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
 if(url.endsWith('/stream'))return new Response(JSON.stringify({type:'text',text:'작성 중'})+'\n'+JSON.stringify({type:'done',result:{messages:[{id:'reply',role:'assistant',body:'저장된 답변'}],proposals:[]}})+'\n');
 return new Response(JSON.stringify({messages:[],proposals:[]}));
}));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('uses streaming endpoint and replaces draft only after persisted completion',async()=>{
 render(<SecretariatChat/>);fireEvent.change(screen.getByLabelText('비서에게 말하기'),{target:{value:'이어서 이야기해줘'}});fireEvent.click(screen.getByText('보내기'));
 await screen.findByText('저장된 답변');expect((screen.getByLabelText('비서에게 말하기') as HTMLTextAreaElement).value).toBe('');
 expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/chat/stream'),expect.objectContaining({method:'POST'}));
});
it('does not erase input on stream failure',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(url.endsWith('/stream')?JSON.stringify({type:'error',message:'저장 실패'})+'\n':JSON.stringify({messages:[],proposals:[]}))));
 render(<SecretariatChat/>);fireEvent.change(screen.getByLabelText('비서에게 말하기'),{target:{value:'보존할 입력'}});fireEvent.click(screen.getByText('보내기'));
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe('저장 실패'));expect((screen.getByLabelText('비서에게 말하기') as HTMLTextAreaElement).value).toBe('보존할 입력');
});
it('shows the sent message before the answer and stops without losing input',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string,opts:any)=>{
  if(!url.endsWith('/stream'))return new Response(JSON.stringify({messages:[],proposals:[]}));
  return await new Promise<Response>((_resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));
 }));
 render(<SecretariatChat/>);
 fireEvent.change(screen.getByLabelText('비서에게 말하기'),{target:{value:'즉시 표시할 메시지'}});
 fireEvent.click(screen.getByText('보내기'));
 expect(screen.getAllByText('즉시 표시할 메시지').some(e=>e.tagName==='DIV')).toBe(true);
 fireEvent.click(screen.getByText('중단'));
 await screen.findByRole('alert');
 expect((screen.getByLabelText('비서에게 말하기') as HTMLTextAreaElement).value).toBe('즉시 표시할 메시지');
 expect(screen.queryAllByText('즉시 표시할 메시지').filter(e=>e.tagName==='DIV')).toHaveLength(0);
});

it('Enter sends while Shift+Enter and composition do not',async()=>{
 render(<SecretariatChat/>);const input=screen.getByLabelText('비서에게 말하기');
 fireEvent.change(input,{target:{value:'전송'}});
 fireEvent.keyDown(input,{key:'Enter',shiftKey:true});
 fireEvent.keyDown(input,{key:'Enter',isComposing:true,keyCode:229});
 expect(vi.mocked(fetch).mock.calls.filter(c=>String(c[0]).endsWith('/stream'))).toHaveLength(0);
 fireEvent.keyDown(input,{key:'Enter'});await screen.findByText('저장된 답변');
 expect(vi.mocked(fetch).mock.calls.filter(c=>String(c[0]).endsWith('/stream'))).toHaveLength(1);
});
it('refreshes briefing immediately rather than waiting for the polling interval',async()=>{
 const {rerender}=render(<SecretariatChat/>);
 await waitFor(()=>expect(fetch).toHaveBeenCalled());
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({messages:[],proposals:[{id:'brief',title:'새 브리핑',body:'결과 본문',createdAt:'2026-10-17'}]})));
 rerender(<SecretariatChat briefingResult={{id:'brief',sequence:1}}/>);
 await screen.findByText(/새 브리핑/);
 expect(screen.getByText(/결과 본문/)).toBeTruthy();
});
it('recovers a completed saved answer after transport failure without replaying inference',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
  if(url.includes('/requests/'))return new Response(JSON.stringify({status:'completed',snapshot:{messages:[{id:'restored',role:'assistant',body:'복구된 답변'}],proposals:[]}}));
  if(url.endsWith('/stream'))throw new Error('network');
  return new Response(JSON.stringify({messages:[],proposals:[]}));
 }));
 render(<SecretariatChat/>);fireEvent.change(screen.getByLabelText('비서에게 말하기'),{target:{value:'요청'}});fireEvent.click(screen.getByText('보내기'));
 await screen.findByText('복구된 답변');expect(vi.mocked(fetch).mock.calls.filter(c=>String(c[0]).endsWith('/stream'))).toHaveLength(1);
 expect((screen.getByLabelText('비서에게 말하기') as HTMLTextAreaElement).value).toBe('');
});
it('restores only the account-scoped request identity after reopening and checks persisted result',async()=>{
 localStorage.setItem('token',`x.${btoa(JSON.stringify({userId:7}))}.x`);
 sessionStorage.setItem('secretary-request:7','request-to-restore');
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(JSON.stringify(url.includes('/requests/')?{status:'completed',snapshot:{messages:[{id:'restored',role:'assistant',body:'다시 연 결과'}],proposals:[]}}:{messages:[],proposals:[]}))));
 render(<SecretariatChat/>);await screen.findByText('다시 연 결과');
 expect(sessionStorage.getItem('secretary-request:7')).toBeNull();
 expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/requests/request-to-restore'),expect.anything());
 localStorage.removeItem('token');sessionStorage.clear();
});
it('requires server tombstone before releasing an unknown request',async()=>{
 localStorage.setItem('token',`x.${btoa(JSON.stringify({userId:7}))}.x`);sessionStorage.setItem('secretary-request:7','unknown-request');
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(JSON.stringify(url.endsWith('/resolve')?{status:'interrupted'}:url.includes('/requests/')?{status:'unknown'}:{messages:[],proposals:[]}))));
 render(<SecretariatChat/>);
 await screen.findByText('저장 여부가 불명확합니다. 결과를 확인하기 전에는 새 전송을 보류합니다.');
 expect(sessionStorage.getItem('secretary-request:7')).toBe('unknown-request');
 fireEvent.click(screen.getByText('이 요청 정리'));
 await waitFor(()=>expect(sessionStorage.getItem('secretary-request:7')).toBeNull());
 expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/resolve'),expect.objectContaining({method:'POST'}));
 localStorage.removeItem('token');sessionStorage.clear();
});
