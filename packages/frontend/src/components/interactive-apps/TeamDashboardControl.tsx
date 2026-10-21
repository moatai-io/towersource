import { DashboardRegistrationForm } from './DashboardRegistrationForm';
import { parseControlRegistry } from '../../../../shared/publishing/control-room-registry';
import React, { useEffect, useState } from 'react';
import type { Project } from '@tower/shared';
import { useTranslation } from 'react-i18next';
import { PricingFilePreview } from './PricingFilePreview';
import { HtmlPreviewSurface } from '../files/HtmlPreviewSurface';

type Card = { projectId:string; owner:string; root:string; slug:string; title:string; format?:'html'; entry?:string };
export { parseControlRegistry } from '../../../../shared/publishing/control-room-registry';
async function api(path:string,kind:'tree'|'read',signal:AbortSignal){const token=localStorage.getItem('token');const res=await fetch(`/api/files/${kind}?path=${encodeURIComponent(path)}`,{signal,headers:token?{Authorization:`Bearer ${token}`}:{}});if(!res.ok)throw Error('access');return res.json();}
/** Project files remain authoritative; registry membership is explicit, never inferred from all dashboards. */
export function TeamDashboardControl({projects}:{projects:Project[]}) {
  const {t}=useTranslation('layout');const [revision,setRevision]=useState(0);const [cards,setCards]=useState<Card[]>([]);const [failed,setFailed]=useState(0);const [loading,setLoading]=useState(true);const [selected,setSelected]=useState<Card|null>(null);const [content,setContent]=useState<string|null>(null);const [openError,setOpenError]=useState(false);
  const scope=JSON.stringify(projects.filter(p=>!p.archived&&p.rootPath).map(p=>({projectId:p.id,root:p.rootPath,owner:p.agent?.displayName||p.name})));
  useEffect(()=>{const controller=new AbortController();setCards([]);setFailed(0);setLoading(true);setSelected(null);setContent(null);(async()=>{const next:Card[]=[];let failures=0;for(const p of JSON.parse(scope)){if(controller.signal.aborted)return;try{const root=await api(p.root,'tree',controller.signal);if(!Array.isArray(root.entries))throw Error('shape');if(!root.entries.some((e:any)=>e.name==='dashboards'&&e.isDirectory))continue;const dir=await api(`${p.root}/dashboards`,'tree',controller.signal);if(!Array.isArray(dir.entries))throw Error('shape');if(!dir.entries.some((e:any)=>e.name==='control-room.json'&&!e.isDirectory))continue;const data=await api(`${p.root}/dashboards/control-room.json`,'read',controller.signal);if(typeof data.content!=='string'||data.content.length>65536)throw Error('size');for(const item of parseControlRegistry(JSON.parse(data.content)))next.push({...p,...item});}catch{failures++;}}if(!controller.signal.aborted){setCards(next);setFailed(failures);setLoading(false);}})();return()=>controller.abort();},[scope,revision]);
  useEffect(()=>{setContent(null);setOpenError(false);if(!selected)return;const controller=new AbortController();api(`${selected.root}/dashboards/${selected.slug}/${selected.format==='html'?selected.entry:'dashboard.pricing-app.json'}`,'read',controller.signal).then(data=>{if(typeof data.content!=='string')throw Error('shape');if(!controller.signal.aborted)setContent(data.content)}).catch(()=>{if(!controller.signal.aborted)setOpenError(true)});return()=>controller.abort();},[selected]);
  return <section aria-label={t('teamControl.title')} className="space-y-4">
    <div className="flex items-center justify-between"><h2 className="text-lg font-semibold text-surface-100">{t('teamControl.title')}</h2><button className="rounded border border-surface-700 px-3 py-2 text-sm" onClick={()=>setRevision(v=>v+1)}>{t('teamControl.refresh')}</button></div>
    <p className="text-sm text-surface-400">{t('teamControl.description')}</p>
    <DashboardRegistrationForm projects={projects} onRegistered={()=>setRevision(v=>v+1)}/>
    {loading&&<p role="status">{t('teamControl.loading')}</p>}
    {failed>0&&<p role="alert">{t('teamControl.failed',{count:failed})}</p>}
    {!loading&&cards.length===0&&<p className="rounded-lg border border-surface-800 p-6">{t('teamControl.empty')}</p>}
    <ul className="grid gap-3 md:grid-cols-2">{cards.map(card=><li key={`${card.projectId}:${card.slug}`}><button className="w-full rounded-lg border border-surface-700 p-4 text-left hover:bg-surface-900" onClick={()=>setSelected(card)}><strong className="block text-surface-100">{card.title}</strong><span className="mt-2 block text-sm text-surface-400">{t('teamControl.owner')}: {card.owner}</span><span className="block text-xs text-surface-500">{t('teamControl.manual')}</span></button></li>)}</ul>
    {selected&&<section aria-label={selected.title} className="overflow-hidden rounded-lg border border-surface-700"><div className="flex justify-between p-3"><h3>{selected.title}</h3><button onClick={()=>setSelected(null)}>{t('teamControl.close')}</button></div>{openError?<p role="alert" className="p-4">{t('teamControl.openError')}</p>:content!==null?(selected.format==='html'?<div className="h-[75vh]"><HtmlPreviewSurface content={content} className="h-full" /></div>:<PricingFilePreview content={content}/>):<p role="status" className="p-4">{t('teamControl.loading')}</p>}</section>}
  </section>;
}
