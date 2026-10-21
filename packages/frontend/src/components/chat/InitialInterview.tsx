import {useEffect,useState} from 'react';
const apiFetch = (url:string, options?:RequestInit) => fetch(url, {...options, credentials:'include'});
type State={questionId:string;revision?:number;question?:string;status:string};
export function InitialInterview({sessionId}:{sessionId:string}) {
 const [state,setState]=useState<State|null>(null),[answer,setAnswer]=useState(''),[error,setError]=useState(''),[execution,setExecution]=useState<string|null>(null);
 useEffect(()=>{let active=true;setState(null);const load=()=>apiFetch(`/api/sessions/${sessionId}/initial-interview`).then(r=>r.json()).then(v=>{if(active){setState(v.state);setExecution(v.execution);}}).catch(()=>{});load();const timer=setInterval(load,2000);return()=>{active=false;clearInterval(timer);};},[sessionId]);
 if(!state)return null;
 if(state.status==='failed')return <p role="status">자동 첫 안내가 실행되지 않았습니다. 대화에서 상황이나 업무를 알려주시면 그대로 이어갑니다. 자동 재실행은 하지 않습니다.</p>;
 if(state.status==='completed')return <p>첫 실행안을 준비했습니다. 대화에서 업무를 시작할 수 있습니다.</p>;
 if(state.status!=='awaiting')return null;
 const save=async(skip:boolean)=>{try{const r=await apiFetch(`/api/sessions/${sessionId}/initial-interview`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...state,answer:skip?null:answer})});if(!r.ok)throw new Error();setState((await r.json()).state);setError('');}catch{setError('저장하지 못했습니다. 새로고침 후 다시 확인해 주세요. 업무는 계속할 수 있습니다.');}};
 return <section aria-label="첫 대면 인터뷰" className="px-4 py-2 text-sm border-b">
 <p>생성 입력을 보존했습니다. 첫 안내 상태: {execution==='running'?'작성 중':execution==='completed'?'첫 안내 실행 종료':execution==='failed'?'실패 · 업무는 계속할 수 있습니다':execution==='skipped-user-started'?'사용자 업무 우선으로 생략':'예약 대기'}. 첫 안내에는 모델 사용량이 발생하며 기존 중지 기능으로 중지할 수 있습니다. 대화의 질문에 답하거나 바로 업무를 맡겨 주세요.</p>
 {state.question && <p>{state.question}</p>}
 <label>이 질문에 답하기 (답변과 근거가 자동 저장됩니다)<textarea value={answer} maxLength={8000} onChange={e=>setAnswer(e.target.value)} className="block w-full border rounded p-2" /></label>
 <button disabled={!answer.trim()} onClick={()=>void save(false)}>답변 보내기</button> <button onClick={()=>void save(true)}>인터뷰 건너뛰기</button>
 {error&&<p role="alert">{error}</p>}
 </section>;
}
