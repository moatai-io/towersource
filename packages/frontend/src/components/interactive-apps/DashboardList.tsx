import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileEntry } from '../../stores/file-store';

/** Lists only tool-owned dashboard slots using the existing ACL-protected file API. */
export function DashboardList({rootPath,onOpen}:{rootPath:string;onOpen:(entry:FileEntry)=>void}) {
  const {t}=useTranslation('layout');
  const [expanded,setExpanded]=useState(false);
  const [revision,setRevision]=useState(0);
  const [items,setItems]=useState<FileEntry[]>([]);
  const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
  useEffect(()=>{
    if(!expanded)return;
    const controller=new AbortController(); setItems([]);setStatus('loading');
    const headers:Record<string,string>={};const token=localStorage.getItem('token');if(token)headers.Authorization=`Bearer ${token}`;
    async function list(path:string):Promise<FileEntry[]>{const res=await fetch(`/api/files/tree?path=${encodeURIComponent(path)}`,{headers,signal:controller.signal});if(!res.ok)throw Error('lookup');const data=await res.json();if(!Array.isArray(data.entries))throw Error('shape');return data.entries;}
    (async()=>{
      const root=await list(rootPath);
      const folder=root.find(e=>e.name==='dashboards'&&e.isDirectory);
      if(!folder)return [];
      const slots=(await list(folder.path)).filter(e=>e.isDirectory&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(e.name));
      const found:FileEntry[]=[];
      // Sequential bounded browsing avoids a burst of requests on large Projects.
      for(const slot of slots.slice(0,100)) { const files=await list(slot.path);const file=files.find(e=>!e.isDirectory&&e.name==='dashboard.pricing-app.json');if(file)found.push({...file,name:slot.name}); }
      return found.sort((a,b)=>a.name.localeCompare(b.name));
    })().then(next=>{if(!controller.signal.aborted){setItems(next);setStatus('ready')}}).catch(()=>{if(!controller.signal.aborted)setStatus('error')});
    return()=>controller.abort();
  },[rootPath,expanded,revision]);
  return <section className="border-b border-surface-800 p-3" aria-label={t('dashboardList.title')}>
    <button type="button" className="flex w-full items-center justify-between text-sm font-semibold text-surface-100" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{t('dashboardList.title')}<span aria-hidden>{expanded?'−':'+'}</span></button>
    {expanded&&<div className="mt-3 space-y-2 text-xs text-surface-300">
      <p>{t('dashboardList.scope')}</p>
      {status==='loading'&&<p role="status">{t('dashboardList.loading')}</p>}
      {status==='error'&&<p role="alert">{t('dashboardList.error')}</p>}
      {status==='ready'&&items.length===0&&<p>{t('dashboardList.empty')}</p>}
      {status==='ready'&&<ul>{items.map(item=><li key={item.path}><button type="button" className="w-full rounded px-2 py-2 text-left text-surface-100 hover:bg-surface-800" onClick={()=>onOpen(item)}>{item.name}</button></li>)}</ul>}
      <button type="button" onClick={()=>setRevision(v=>v+1)} className="rounded border border-surface-700 px-2 py-1">{t('dashboardList.refresh')}</button>
    </div>}
  </section>;
}
