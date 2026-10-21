// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HelpPanel } from './HelpPanel';
import { useSettingsStore } from '../../stores/settings-store';
vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({t:(key:string)=>key}) }));
vi.mock('../../utils/markdown-plugins', () => ({remarkGfmPlugin:()=>{}}));
const ko=[{slug:'05-tasks',title:'작업',order:5},{slug:'10-support-ai',title:'지원 AI',order:10}];
const en=[{slug:'05-work-and-automations',title:'Work',order:5},{slug:'10-support-ai',title:'Support AI',order:10}];
beforeEach(()=>{localStorage.clear();useSettingsStore.setState({helpOpen:true});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('navigates local topic links and maps localized filenames without changing location',async()=>{
 const fetcher=vi.fn(async(input:string)=>({ok:true,json:async()=>input.includes('lang=en')?en:ko,text:async()=>'# Body\n[Next](./10-support-ai.md)'}));vi.stubGlobal('fetch',fetcher);
 render(<HelpPanel/>);await screen.findByRole('link',{name:'Next'});fireEvent.click(screen.getByRole('link',{name:'Next'}));
 await waitFor(()=>expect(fetcher).toHaveBeenCalledWith('/api/help/10-support-ai?lang=ko',expect.anything()));
 fireEvent.click(screen.getByRole('button',{name:'작업'}));
 fireEvent.click(screen.getByRole('button',{name:'EN'}));
 await waitFor(()=>expect(fetcher).toHaveBeenCalledWith('/api/help/05-work-and-automations?lang=en',expect.anything()));
 expect(fetcher.mock.calls.some(([url])=>url==='/api/help/05-tasks?lang=en')).toBe(false);
});
it('shows topic-list errors and retries successfully',async()=>{
 let fail=true;vi.stubGlobal('fetch',vi.fn(async()=>({ok:!fail,json:async()=>ko,text:async()=>'Recovered'})));
 render(<HelpPanel/>);await screen.findByRole('alert');fail=false;fireEvent.click(screen.getByRole('button',{name:'retry'}));await screen.findByText('Recovered');
});
it('shows content errors and retries successfully',async()=>{
 let fail=true;vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:url.startsWith('/api/help?')||!fail,json:async()=>ko,text:async()=>'Recovered'})));
 render(<HelpPanel/>);await screen.findByRole('alert');fail=false;fireEvent.click(screen.getByRole('button',{name:'retry'}));await screen.findByText('Recovered');
});

it('ignores an obsolete content response after topic navigation',async()=>{
 let resolveOld:(value:unknown)=>void=()=>{};
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
  if(url.startsWith('/api/help?'))return {ok:true,json:async()=>ko};
  if(url.includes('05-tasks'))return {ok:true,text:()=>new Promise(resolve=>{resolveOld=resolve})};
  return {ok:true,text:async()=>'Current topic'};
 }));
 render(<HelpPanel/>);await screen.findByRole('button',{name:'지원 AI'});
 fireEvent.click(screen.getByRole('button',{name:'지원 AI'}));await screen.findByText('Current topic');
 resolveOld('Obsolete topic');await new Promise(resolve=>setTimeout(resolve,10));
 expect(screen.queryByText('Obsolete topic')).toBeNull();
});
