import { towerHttpUrl, readBrowserAuthToken } from '../client-connection/connection';
import { MessageBubble } from '../../components/chat/MessageBubble';
import React, { useEffect, useState, useRef } from 'react';
import { useSessionStore } from '../../stores/session-store';
export function SecretariatChat({briefingResult,briefing=false,briefingMessage='',onBriefing,onRead}: {
  briefingResult?:{id:string;sequence:number}|null;briefing?:boolean;briefingMessage?:string;onBriefing?:()=>void;onRead?:(id:string)=>Promise<void>;
} = {}) {
  const recoveryKey=(()=>{try{const token=readBrowserAuthToken()||'';const payload=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));return payload.userId!=null?`secretary-request:${payload.userId}`:null;}catch{return null;}})();
  const unresolved=useRef<string|null>((()=>{try{return recoveryKey?sessionStorage.getItem(recoveryKey):null;}catch{return null;}})());
  const [recovering,setRecovering]=useState(false);
  const [blocked,setBlocked]=useState(!!unresolved.current);
  const remember=(id:string|null)=>{unresolved.current=id;setBlocked(!!id);try{if(recoveryKey){if(id)sessionStorage.setItem(recoveryKey,id);else sessionStorage.removeItem(recoveryKey);}}catch{/* Memory state still fences sends when browser storage is blocked. */}};
  const recover=async(resolve=false)=>{
    const id=unresolved.current;if(!id||recovering)return;
    setRecovering(true);
    try{
      const response=await fetch(towerHttpUrl(`/api/secretariat/chat/requests/${id}${resolve?'/resolve':''}`),{method:resolve?'POST':'GET',headers:{Authorization:`Bearer ${readBrowserAuthToken()}`}});
      if(!response.ok)throw new Error('unavailable');const result=await response.json();
      if(result.status==='completed'){hasSent.current=true;setMessages(result.snapshot.messages||[]);setNotes(result.snapshot.proposals||[]);setText('');setError('');remember(null);}
      else if(['failed','stopped','interrupted'].includes(result.status)){remember(null);setError('이전 답변이 완료되지 않았습니다. 내용을 확인해 다시 보낼 수 있습니다.');}
      else setError(result.status==='running'?'아직 처리 중입니다. 잠시 후 결과를 확인해 주세요.':'저장 여부가 불명확합니다. 결과를 확인하기 전에는 새 전송을 보류합니다.');
    }catch{setError('결과를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.');}finally{setRecovering(false);}
  };
  useEffect(()=>{if(unresolved.current)void recover();},[]);
  const composer=useRef<HTMLFormElement>(null);
  const [composerHeight,setComposerHeight]=useState(200);
  const lastFeed=useRef('');
  const viewport=useRef<HTMLDivElement>(null);
  const follow=useRef(true);
  const [newMessage,setNewMessage]=useState(false);
  const seen=useRef(new Set<string>());
  const hasSent=useRef(false);
  const streamAbort=useRef<AbortController | null>(null);
  useEffect(()=>()=>streamAbort.current?.abort(),[]);

  const [pending,setPending]=useState<{body:string;at:number}|null>(null);
  const [draft,setDraft]=useState('');
  const [streamStatus,setStreamStatus]=useState('');
  const [messages,setMessages] = useState<Array<{id:string;role:string;body:string;created_at?:string}>>([]);
  const [notes,setNotes] = useState<Array<{id:string;title:string;body:string;createdAt:string;sessionId?:string|null}>>([]);
  const [text,setText] = useState(''); const [busy,setBusy] = useState(false); const [error,setError] = useState('');
  const request = async (message?:string, signal?:AbortSignal) => {
    const response = await fetch(towerHttpUrl(`/api/secretariat/chat`), { method: message ? 'POST':'GET', signal,
      headers: { Authorization:`Bearer ${readBrowserAuthToken()}`, 'Content-Type':'application/json' },
      ...(message ? {body:JSON.stringify({message})}: {}) });
    if (!response.ok) throw new Error('대화를 불러오지 못했습니다. 접근 가능한 최근 대화와 모델 연결을 확인하거나 잠시 후 다시 시도해 주세요.');
    const data = await response.json();
    if (data.conversationId) {
      const store = useSessionStore.getState();
      if (!store.sessions.some(s => s.id === data.conversationId)) {
        const r = await fetch(towerHttpUrl(`/api/sessions/${data.conversationId}`), { signal, headers: { Authorization: `Bearer ${readBrowserAuthToken()}` } });
        if (r.ok) { const session = await r.json(); useSessionStore.setState(state => ({ sessions: [session,...state.sessions.filter(s=>s.id!==session.id)] })); }
      }
    }
    return data;
  };
  useEffect(() => { const controller=new AbortController(); const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void request(undefined,controller.signal).then(d=>setNotes(d.proposals || [])).catch(()=>{});},60_000); void request(undefined,controller.signal).then(d=>{if(!hasSent.current){setNotes(d.proposals || []);setMessages(d.messages || []);}}).catch(()=>{if(!controller.signal.aborted)setError('대화를 불러오지 못했습니다.');}); return ()=>{controller.abort();window.clearInterval(timer);}; },[]);
  useEffect(()=>{
    if(!briefingResult)return;
    const controller=new AbortController();let timer:number|undefined;
    void request(undefined,controller.signal).then(data=>{
      if(controller.signal.aborted)return;
      setNotes(data.proposals||[]);
      timer=window.setTimeout(()=>document.getElementById(`secretary-note-${briefingResult.id}`)?.scrollIntoView?.({behavior:'smooth',block:'center'}),0);
    }).catch(()=>{if(!controller.signal.aborted)setError('브리핑을 불러오지 못했습니다. 다시 시도해 주세요.');});
    return()=>{controller.abort();if(timer!==undefined)window.clearTimeout(timer);};
  },[briefingResult]);
  useEffect(()=>{
    if(!composer.current||typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(()=>setComposerHeight(composer.current?.offsetHeight||200));
    observer.observe(composer.current);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    const root=viewport.current;
    if(!root||typeof IntersectionObserver==='undefined')return;
    const visible=new Set<string>();
    const acknowledge=(ids:Iterable<string>)=>{
      if(document.visibilityState!=='visible')return;
      for(const id of ids){
        if(seen.current.has(id))continue;
        seen.current.add(id);
        const read=onRead ? onRead(id) : fetch(towerHttpUrl(`/api/secretariat/proposals/${encodeURIComponent(id)}/read`),{method:'POST',headers:{Authorization:`Bearer ${readBrowserAuthToken()}`}}).then(r=>{if(!r.ok)throw new Error('read_failed');});
        void read.catch(()=>seen.current.delete(id));
      }
    };
    const observer=new IntersectionObserver(entries=>{
      for(const entry of entries){const id=(entry.target as HTMLElement).dataset.proposalEnd;if(!id)continue;if(entry.isIntersecting)visible.add(id);else visible.delete(id);}
      acknowledge(visible);
    },{root,threshold:1});
    const resume=()=>acknowledge(visible);
    document.addEventListener('visibilitychange',resume);
    root.querySelectorAll('[data-proposal-end]').forEach(node=>observer.observe(node));
    return()=>{observer.disconnect();document.removeEventListener('visibilitychange',resume);};
  },[notes,onRead]);
  useEffect(()=>{
    const root=viewport.current;if(!root)return;
    const signature=JSON.stringify({messages:messages.map(m=>[m.id,m.body]),notes:notes.map(n=>[n.id,n.body]),draft,pending,streamStatus});
    if(signature===lastFeed.current)return;
    lastFeed.current=signature;
    if(follow.current){root.scrollTop=root.scrollHeight;setNewMessage(false);}else setNewMessage(true);
  },[messages,notes,draft,pending,streamStatus]);
  const send=async()=>{
    if(busy||blocked||!text.trim())return;
    const controller=new AbortController();streamAbort.current=controller;
    const requestId=crypto.randomUUID();remember(requestId);
    follow.current=true;
    hasSent.current=true;
    const sentText=text.trim();setPending({body:sentText,at:Date.now()});
    setBusy(true);setError('');setDraft('');setStreamStatus('답변을 준비하고 있어요.');
    try{
      const response=await fetch(towerHttpUrl(`/api/secretariat/chat/stream`),{method:'POST',signal:controller.signal,
        headers:{Authorization:`Bearer ${readBrowserAuthToken()}`,'Content-Type':'application/json'},body:JSON.stringify({message:sentText,requestId})});
      if(!response.ok||!response.body)throw new Error('답변을 시작하지 못했습니다.');
      const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';let completed=false;
      while(true){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});
        let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line.trim())continue;
          const event=JSON.parse(line);
          if(event.type==='text'){setDraft(event.text);setStreamStatus('');}
          if(event.type==='compact')setStreamStatus('앞선 대화 맥락을 정리하고 있어요.');
          if(event.type==='error')throw new Error(event.message);
          if(event.type==='done'){completed=true;remember(null);setMessages(event.result.messages||[]);setNotes(event.result.proposals||[]);setText('');setDraft('');setPending(null);}
        }
      }
      if(!completed)throw new Error('연결이 끝나 답변 저장을 확인하지 못했습니다.');
    }catch(e){
      setDraft('');setPending(null);
      try{
        const check=await fetch(towerHttpUrl(`/api/secretariat/chat/requests/${requestId}`),{headers:{Authorization:`Bearer ${readBrowserAuthToken()}`}});
        if(!check.ok)throw new Error('unavailable');
        const recovered=await check.json();
        if(['failed','stopped','interrupted'].includes(recovered.status))remember(null);
        if(recovered.status==='completed'){remember(null);setMessages(recovered.snapshot.messages||[]);setNotes(recovered.snapshot.proposals||[]);setText('');setError('');}
        else setError(recovered.status==='running'?'서버에서 아직 처리 중입니다. 다시 보내지 말고 잠시 후 비서실을 다시 열어 확인해 주세요.':controller.signal.aborted?'답변을 중단했습니다. 입력한 내용은 남겨두었습니다.':(e as Error).message);
      }catch{setError('저장 여부를 확인하지 못했습니다. 중복 전송하지 말고 비서실을 다시 열어 확인해 주세요.');}
    }
    finally{setBusy(false);setStreamStatus('');streamAbort.current=null;}
  };
  return <section aria-label="비서와 대화" className="relative flex min-h-0 flex-1 flex-col">
    <h2 className="sr-only">비서와 이야기하기</h2>
    <div ref={viewport} data-testid="secretary-conversation-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6" onScroll={()=>{const root=viewport.current;if(root){follow.current=root.scrollHeight-root.scrollTop-root.clientHeight<80;if(follow.current)setNewMessage(false);}}}>
    {!messages.length&&!notes.length&&!busy&&<div className="mx-auto max-w-xl py-8 text-surface-400"><p className="text-lg text-surface-100">어떤 일을 함께 챙겨볼까요?</p><p className="mt-3 text-sm leading-relaxed">바로 이야기하거나, 비서 브리핑으로 최근 하던 일을 살펴보세요.</p></div>}
    {[...messages.map(m=>({...m,at:m.created_at || '',proposal:false})), ...notes.map(n=>({id:n.id,role:'assistant',body:`${n.title}\n\n${n.body}`,at:n.createdAt,proposal:true}))]
      .sort((a,b)=>a.at.localeCompare(b.at)).map(m=><div key={m.id} id={`secretary-note-${m.id}`} tabIndex={-1}><MessageBubble message={{ id:m.id,role:m.role === 'user'?'user':'assistant',content:[{type:'text',text:m.body}],timestamp:Date.parse(m.at)||0 }} showMetrics={false} />{m.proposal&&<><button type="button" className="ml-4 min-h-9 text-xs text-primary-400" disabled={!notes.find(n=>n.id===m.id)?.sessionId} onClick={event=>{event.preventDefault();const note=notes.find(n=>n.id===m.id) as any;if(note?.sessionId)window.dispatchEvent(new CustomEvent('kanban-select-session',{detail:{sessionId:note.sessionId}}));}}>관련 대화</button><span className="block h-px" data-proposal-end={m.id}/></>}</div>)}
    {pending&&<MessageBubble message={{id:'secretary-pending-user',role:'user',content:[{type:'text',text:pending.body}],timestamp:pending.at}} showMetrics={false}/>}
    {draft&&<MessageBubble message={{id:'secretary-stream',role:'assistant',content:[{type:'text',text:draft}],timestamp:Date.now()}} showMetrics={false}/>}
    {streamStatus&&<p role="status" className="text-sm text-surface-400">{streamStatus}</p>}
    {briefingMessage&&<p role="status" className="mx-auto max-w-xl py-4 text-sm text-surface-400">{briefingMessage}</p>}
    </div>
    {newMessage&&<button style={{bottom:composerHeight+12}} className="absolute right-6 rounded-full border border-surface-700 bg-surface-900 px-4 py-2 text-sm shadow-lg" onClick={()=>{follow.current=true;if(viewport.current)viewport.current.scrollTop=viewport.current.scrollHeight;setNewMessage(false);}}>새 메시지 ↓</button>}
    {blocked&&!busy&&<div className="shrink-0 border-t border-surface-700 p-3 text-sm"><p>이전 요청의 저장 상태를 먼저 확인해 주세요.</p><button type="button" disabled={recovering} onClick={()=>void recover(false)} className="mt-2 min-h-11 rounded-lg border border-surface-600 px-3">{recovering?'확인 중…':'결과 확인'}</button><button type="button" disabled={recovering} onClick={()=>void recover(true)} className="ml-2 min-h-11 rounded-lg px-3 text-surface-400">이 요청 정리</button></div>}
    <form ref={composer} className="shrink-0 border-t border-surface-800 bg-surface-900 p-3 sm:p-5" aria-busy={busy} onSubmit={e=>{e.preventDefault();void send();}}>
      {onBriefing&&<button type="button" className="mb-3 min-h-9 rounded-full border border-surface-700 px-3 text-xs text-surface-300 disabled:opacity-50" disabled={busy||briefing} onClick={onBriefing}>{briefing?'최근 대화를 살펴보고 있어요…':'비서 브리핑'}</button>}
      <label className="sr-only" htmlFor="secretariat-message">비서에게 말하기</label>
      <textarea id="secretariat-message" maxLength={2000} value={text} onChange={e=>setText(e.target.value)} placeholder="비서에게 이야기해 보세요." className="w-full rounded-xl border border-surface-700 bg-surface-900 p-3 text-sm" rows={3} disabled={busy} onKeyDown={event=>{
        if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&event.keyCode!==229){event.preventDefault();void send();}
      }}/>
      <div className="mt-2 flex items-center justify-between gap-3"><span className="text-xs text-surface-400">대화만으로 작업이나 예약이 실행되지는 않아요.</span>{busy&&<button type="button" onClick={()=>streamAbort.current?.abort()} className="rounded-lg border border-surface-700 px-3 py-2 text-sm">중단</button>}<button className="rounded-lg bg-primary-600 px-4 py-2 text-sm text-white disabled:opacity-50" disabled={busy||blocked||!text.trim()}>{busy?'답변을 준비하고 있어요…':'보내기'}</button></div>
      {error&&<p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
    </form>
  </section>;
}
