import { describe, expect, it, vi } from 'vitest';
import { runAgentLoop } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from '@sinclair/typebox';
const state=vi.hoisted(()=>({parked:false}));
vi.mock('../services/agent-sleep/alarms.js',()=>({MAX_WAIT_SECONDS:2592000,WAIT_DESCRIPTION:'stored wait',scheduleWait:async()=>{state.parked=true;return {ok:true,status:'scheduled'};}}));
import { createSleepTool } from './pi-sleep-tool.js';
describe('actual Pi SDK mixed wait batch',()=>{
 it('serializes wait then blocks a sibling write, stores results, and ends without a second provider request',async()=>{
  state.parked=false;let writes=0,requests=0;let persistedBoundary=false;
  const wait=createSleepTool({sessionId:'s',rootTurnId:'r'});
  const write={name:'write',label:'write',description:'write',parameters:Type.Object({}),execute:async()=>{writes++;return {content:[{type:'text',text:'written'}],details:{}};}};
  const model={id:'test',name:'test',api:'openai-completions',provider:'openai',baseUrl:'https://example.com',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:4096,maxTokens:1000} as any;
  const stream=()=>{requests++;const s=createAssistantMessageEventStream();const message={role:'assistant',content:[{type:'toolCall',id:'w',name:'wait',arguments:{durationSeconds:86400,reason:'check'}},{type:'toolCall',id:'x',name:'write',arguments:{}}],api:'openai-completions',provider:'openai',model:'test',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:Date.now()} as any;s.push({type:'done',reason:'toolUse',message});return s;};
  const result=await runAgentLoop([{role:'user',content:'wait',timestamp:Date.now()}],{systemPrompt:'',messages:[],tools:[wait,write] as any},{model,convertToLlm:(m:any)=>m,toolExecution:'parallel',beforeToolCall:()=>state.parked?{block:true,reason:'wait already saved'}:undefined,finishTurn:(turn:any)=>{persistedBoundary=turn.context.messages.filter((m:any)=>m.role==='toolResult').length===2;return {action:'end'};}},()=>{},undefined,stream as any);
  expect(wait.executionMode).toBe('sequential');expect(writes).toBe(0);expect(requests).toBe(1);expect(persistedBoundary).toBe(true);
  expect(result.filter((m:any)=>m.role==='toolResult')).toHaveLength(2);expect((result.at(-1) as any).isError).toBe(true);
 });
});
