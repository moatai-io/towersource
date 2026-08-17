/** Owns: recent project session↔file activity graph. */
import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph from 'force-graph';
import type { ForceGraphGeneric } from 'force-graph';

interface ActivityNode { id:string; kind:'session'|'file'; label:string; path?:string; userName?:string; degree?:number; x?:number; y?:number }
interface ActivityEdge { id:string; source:string|ActivityNode; target:string|ActivityNode; kind:'edited' }
interface ActivityResponse { nodes:ActivityNode[]; edges:ActivityEdge[]; summary:{sessions:number;files:number;edges:number} }
type GraphApi = ForceGraphGeneric<ForceGraph<ActivityNode, ActivityEdge>, ActivityNode, ActivityEdge>;
function authHeaders():Record<string,string>{const token=localStorage.getItem('token');return token?{Authorization:`Bearer ${token}`}:{ };}
function endpointId(value:string|ActivityNode){return typeof value==='string'?value:value.id;}

export function ProjectActivityGraph({projectId,onOpenFile,onOpenSession}:{projectId:string;onOpenFile:(path:string)=>void;onOpenSession:(id:string)=>void}){
  const hostRef=useRef<HTMLDivElement>(null); const graphRef=useRef<GraphApi|null>(null);
  const selectedRef=useRef<ActivityNode|null>(null); const [data,setData]=useState<ActivityResponse|null>(null);
  const [error,setError]=useState(''); const [selected,setSelected]=useState<ActivityNode|null>(null); selectedRef.current=selected;
  const graphData=useMemo(()=>{if(!data)return{nodes:[] as ActivityNode[],links:[] as ActivityEdge[]};const degree=new Map<string,number>();for(const edge of data.edges){for(const id of [endpointId(edge.source),endpointId(edge.target)])degree.set(id,(degree.get(id)||0)+1);}return{nodes:data.nodes.map(node=>({...node,degree:degree.get(node.id)||0})),links:data.edges.map(edge=>({...edge}))};},[data]);

  useEffect(()=>{let cancelled=false;setError('');fetch(`/api/projects/${projectId}/activity-graph?rangeDays=90&sessionLimit=50`,{headers:authHeaders()}).then(async res=>{const body=await res.json().catch(()=>({}));if(!res.ok)throw new Error(body.error||`HTTP ${res.status}`);return body as ActivityResponse;}).then(body=>{if(!cancelled)setData(body);}).catch(err=>{if(!cancelled)setError(err instanceof Error?err.message:'작업 흔적을 불러오지 못했습니다');});return()=>{cancelled=true;};},[projectId]);

  useEffect(()=>{const host=hostRef.current;if(!data||!host||graphRef.current)return;const graph=new ForceGraph<ActivityNode,ActivityEdge>(host)
    .backgroundColor('rgba(0,0,0,0)').nodeId('id').warmupTicks(50).cooldownTicks(100).cooldownTime(1600).d3AlphaDecay(.04).d3VelocityDecay(.44).autoPauseRedraw(false)
    .nodeVal(node=>node.kind==='session'?Math.max(7,5+Math.sqrt(node.degree||1)*2):Math.max(3,2+Math.sqrt(node.degree||1)*1.3))
    .nodeColor(node=>node.id===selectedRef.current?.id?'#fbbf24':node.kind==='session'?'#c084fc':'#22d3ee').nodeLabel(node=>`${node.kind==='session'?'세션':'파일'} · ${node.label}`)
    .nodeCanvasObjectMode(()=>'after').nodeCanvasObject((node,ctx,scale)=>{const chosen=node.id===selectedRef.current?.id;const show=node.kind==='session'||chosen||(node.degree||0)>=3||scale>=2.2;if(!show)return;const radius=node.kind==='session'?Math.max(7,5+Math.sqrt(node.degree||1)*2):Math.max(3,2+Math.sqrt(node.degree||1)*1.3);const fontSize=Math.max((node.kind==='session'?11:9)/scale,2.5);ctx.font=`${node.kind==='session'||chosen?'600 ':''}${fontSize}px sans-serif`;ctx.textAlign='center';ctx.textBaseline='bottom';ctx.fillStyle=document.documentElement.dataset.theme==='light'?'rgba(15,23,42,.92)':'rgba(241,245,249,.92)';ctx.fillText(node.label.slice(0,node.kind==='session'?30:24),node.x||0,(node.y||0)-radius-3/scale);})
    .linkColor(()=>'rgba(148,163,184,.32)').linkWidth(.8).enableNodeDrag(true).enableZoomInteraction(true)
    .onNodeClick(node=>{setSelected(node);if(Number.isFinite(node.x)&&Number.isFinite(node.y)){graph.centerAt(node.x,node.y,300);graph.zoom(2.2,300);}});
    const charge=graph.d3Force('charge') as {strength(v:number):unknown;distanceMax(v:number):unknown}|undefined;charge?.strength(-120);charge?.distanceMax(420);graph.d3Force('link')?.distance(64);
    graphRef.current=graph;graph.graphData(graphData);const observer=new ResizeObserver(([entry])=>graph.width(entry.contentRect.width).height(entry.contentRect.height));observer.observe(host);window.setTimeout(()=>graph.zoomToFit(400,50),120);
    return()=>{observer.disconnect();graph.pauseAnimation();host.replaceChildren();graphRef.current=null;};},[data,graphData]);

  useEffect(()=>{const graph=graphRef.current;if(!graph)return;graph.nodeColor(node=>node.id===selected?.id?'#fbbf24':node.kind==='session'?'#c084fc':'#22d3ee');},[selected]);
  if(error)return <div className="grid h-full place-items-center text-sm text-red-400">{error}</div>;
  if(!data)return <div className="grid h-full place-items-center text-sm text-surface-500">최근 작업 흔적을 불러오는 중…</div>;
  return <div className="relative h-full min-h-[560px] overflow-hidden bg-surface-950">
    <div className="pointer-events-none absolute left-4 top-4 z-10 rounded-xl border border-surface-700 bg-surface-900/95 px-3 py-2 text-xs text-surface-400">최근 세션 최대 50개 · 세션 {data.summary.sessions} · 파일 {data.summary.files} · 보라색 큰 노드=세션 / 청록색 작은 노드=파일</div>
    <div ref={hostRef} className="h-full min-h-[560px] w-full" />
    {selected&&<aside className="absolute bottom-4 right-4 z-10 w-[min(22rem,calc(100%-2rem))] rounded-2xl border border-surface-700 bg-surface-900/95 p-4 shadow-2xl"><div className="text-sm font-semibold text-surface-100">{selected.label}</div><div className="mt-1 break-all font-mono text-[10px] text-surface-500">{selected.kind==='session'?(selected.userName||'세션'):selected.path}</div><div className="mt-2 text-[11px] text-surface-400">{selected.kind==='session'?'편집한 파일':'이 파일을 편집한 세션'} {selected.degree||0}</div><button type="button" onClick={()=>selected.kind==='session'?onOpenSession(selected.id.replace(/^session:/,'')):selected.path&&onOpenFile(selected.path)} className="tone-accent tone-action mt-3 rounded-lg px-3 py-2 text-xs font-semibold">{selected.kind==='session'?'세션 열기':'파일 열기'}</button></aside>}
  </div>;
}
