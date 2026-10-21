import { useRef, useState } from 'react';
import { useConfirm } from '../../hooks/useDialog';
import { runBrowserFileCanary, type BrowserCanaryReport } from './browser-file-canary';
export function BrowserFileCanaryButton({projectId,name,token}:{projectId:string;name:string;token?:string|null}) {
 const confirm=useConfirm();const [busy,setBusy]=useState(false);const [report,setReport]=useState<BrowserCanaryReport|null>(null);const [error,setError]=useState('');
 const running = useRef(false);
 const run=async()=>{
  if(running.current)return;
  running.current=true;
  try {
  if(!await confirm({title:'브라우저 파일 API 검사',message:`${name}에 고유한 시험 텍스트 파일 1개를 생성·수정·재읽기합니다. 결과 확인용 파일은 남기며 자동 삭제하지 않습니다. 기존 파일·binding·서비스는 변경하지 않습니다. Worker 실행·Viewer 렌더링은 검사하지 않습니다. 실행할까요?`}))return;
  setBusy(true);setError('');setReport(null);
  try{
   const request=(url:string,init?:RequestInit)=>fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} : {}),...(init?.headers||{})}});
   const response=await request('/api/projects');if(!response.ok)throw Error();
   const projects=await response.json();const project=projects.find((p:{id:string})=>p.id===projectId);if(!project?.rootPath)throw Error();
   setReport(await runBrowserFileCanary(project.rootPath,request));
  }catch{setError('검사 시작 불가: 로그인과 Project 접근 권한을 확인하십시오.');}finally{setBusy(false);}
  } finally { running.current=false; }
 };
 return <span className="inline-flex flex-col items-start gap-1">
  <button disabled={busy} onClick={run} className="rounded-md border border-surface-600 px-3 py-1.5 disabled:opacity-50">{busy?'파일 검사 중…':'파일 API 검사'}</button>
  {error && <span role="alert">{error}</span>}
  {report && <span role="status" className="max-w-sm break-all text-xs">{report.status} · 파일 API만 검사했습니다. Worker·Viewer는 미검증입니다. {report.retained && `시험 파일이 남아 있을 수 있습니다: ${report.path}`} {report.failure && `실패 단계: ${report.failure}`}</span>}
 </span>;
}
