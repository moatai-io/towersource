import React, { useRef, useState } from 'react';
import './pricing-app.css';
import { calculatePricing, parsePricingDeclaration, parsePricingValues, type PricingValues } from '../../../../shared/pricing-app';

/** Mount with key=instanceId. onConfirm must use the authenticated host submission path. */
export function PricingApp({ declaration, onConfirm }: { declaration: unknown; onConfirm?: (snapshot: PricingValues) => Promise<void> }) {
  try { return <PricingForm declaration={parsePricingDeclaration(declaration)} onConfirm={onConfirm} />; }
  catch { return <p role="alert">지원하지 않는 가격 화면입니다.</p>; }
}
function PricingForm({declaration,onConfirm}:{declaration:ReturnType<typeof parsePricingDeclaration>;onConfirm?:(snapshot:PricingValues)=>Promise<void>}) {
  const [fields,setFields]=useState<Record<string,string>>(()=>Object.fromEntries(Object.entries(declaration.initialValues).map(([k,v])=>[k,String(v)])));
  const [snapshot,setSnapshot]=useState<PricingValues|null>(null);
  const [busy,setBusy]=useState(false); const lock=useRef(false);
  const [status,setStatus]=useState('');
  let values:PricingValues|null=null;
  try { if(Object.values(fields).some(v=>v.trim()==='')) throw new Error(); values=parsePricingValues(Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,Number(v)]))); } catch {}
  const result=values?calculatePricing(values):null;
  const labels:Record<keyof PricingValues,string>={customers:'고객 수',price:'월 단가(원)',discount:'할인율(%)',fixed:'월 고정비(원)',variable:'고객당 월 변동비(원)'};
  async function confirm(){if(!snapshot||lock.current||!onConfirm)return;lock.current=true;setBusy(true);setStatus('');try{await onConfirm({...snapshot});setSnapshot(null);setStatus('조건을 전달했습니다.');}catch{setStatus('전달 결과를 확인하지 못했습니다. 중복 전송 여부를 확인한 뒤 다시 시도하세요.');}finally{lock.current=false;setBusy(false)}}
  return <section className="pricing-app" aria-label="가격 시뮬레이터">
    <header className="pricing-app__header"><span className="pricing-app__eyebrow">가격과 비용 비교</span><h2>{declaration.title||'가격 시뮬레이터'}</h2><p>조건을 바꾸면 예상 결과가 바로 반영됩니다.</p></header>
    <div className="pricing-app__layout"><div className="pricing-app__inputs"><h3>계산 조건 <span>원화 · 월 기준</span></h3>
    {(Object.keys(labels) as (keyof PricingValues)[]).map(key=><label className="pricing-app__field" key={key}>{labels[key]}<input className="pricing-app__input" type="number" min="0" max={key==='discount'?100:key==='customers'?1000000:1000000000} step="1" disabled={busy} value={fields[key]} onChange={e=>{setFields({...fields,[key]:e.target.value});setSnapshot(null);setStatus('')}} /></label>)}
    <p className="pricing-app__hint">정수 입력 · 할인율 0~100%</p></div><div className="pricing-app__results"><h3>예상 결과</h3>
    {!result?<p role="alert">입력 범위를 확인하세요. 고객 수는 100만 이하, 금액은 10억 원 이하입니다.</p>:<dl aria-live="polite"><dt>월 매출</dt><dd>{result.revenue.toLocaleString('ko-KR')}원</dd><dt>월 총비용</dt><dd>{result.cost.toLocaleString('ko-KR')}원</dd><dt className="pricing-app__profit-label">월 기여이익</dt><dd className="pricing-app__profit" data-negative={result.contribution<0}>{result.contribution.toLocaleString('ko-KR')}원</dd><dt>손익분기 고객 수</dt><dd>{result.breakEvenCustomers===null?'실효 단가가 변동비 이하이므로 정의할 수 없음':`${result.breakEvenCustomers.toLocaleString('ko-KR')}명`}</dd></dl>}
    </div></div><footer className="pricing-app__footer"><button className="pricing-app__button" disabled={!values||busy||!onConfirm} onClick={()=>{setSnapshot(values?{...values}:null);setStatus('')}}>조건 검토</button>
    {snapshot&&<section className="pricing-app__confirmation" aria-label="전송 확인"><h3>아래 조건을 대화로 전달합니다.</h3><ul>{(Object.keys(labels) as (keyof PricingValues)[]).map(k=><li key={k}>{labels[k]}: {snapshot[k]}</li>)}</ul><button className="pricing-app__button" disabled={busy} onClick={confirm}>{busy?'전달 중':'확인 후 전달'}</button><button className="pricing-app__button" disabled={busy} onClick={()=>setSnapshot(null)}>취소</button></section>}
    {!onConfirm&&<p className="pricing-app__hint">계산은 사용할 수 있습니다.<br/>대화 전송은 아직 연결되지 않았습니다.</p>}<p role="status">{status}</p></footer>
  </section>;
}
