// Explicit live-provider canary. Synthetic documents only; no production sessions.
// Invoke: npx tsx packages/backend/scripts/pdf-visual-batch-canary.ts --live
// PDF_CANARY_PAGES=100 PDF_CANARY_DOCUMENTS=1 + --compact-resume persists a local canary.
// PDF_CANARY_RESUME_ROOT reuses only a synthetic canary; --verify-existing skips rereading.
// PDF_CANARY_COMPARE_PAGES=39 allows targeted requery without exposing the expected code.
import fs from 'node:fs/promises';
import { verifyPdfCanaryPages } from './pdf-canary-verdict.js';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createAgentSession, createExtensionRuntime, SessionManager, SettingsManager, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import { PiModelRegistryManager } from '../engines/pi/model-registry.js';
import { createPdfViewTool } from '../engines/pi-pdf-view-tool.js';
import { installPiVisualContextTransform } from '../engines/pi/visual-context-lifecycle.js';
import { stripPdfObservationText } from '../engines/pi/pdf-observation-visibility.js';
import { PdfObservationState, PDF_OBSERVATION_ENTRY } from '../engines/pi/pdf-observation-state.js';
import { installPiProviderSafeguards } from '../engines/pi/provider-safeguards.js';

async function main() {
  if (!process.argv.includes('--live')) throw new Error('Explicit --live required: this uses provider inference.');
  const resumeRoot = process.env.PDF_CANARY_RESUME_ROOT ? path.resolve(process.env.PDF_CANARY_RESUME_ROOT) : undefined;
  if (resumeRoot && !resumeRoot.startsWith(path.resolve('work/pdf-visual-batch-canary') + path.sep)) throw new Error('Resume must be a local synthetic canary');
  const root = resumeRoot || path.resolve('work/pdf-visual-batch-canary', new Date().toISOString().replace(/[:.]/g,'-'));
  const attempt = new Date().toISOString().replace(/[:.]/g,'-');
  await fs.mkdir(root, { recursive: true });
  const pages = Number(process.env.PDF_CANARY_PAGES || 3);
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > 100) throw new Error('Invalid synthetic page count');
  const docCount = Number(process.env.PDF_CANARY_DOCUMENTS || 2);
  if (![1, 2].includes(docCount)) throw new Error('Invalid synthetic document count');
  const comparisonPages = [...new Set((process.env.PDF_CANARY_COMPARE_PAGES || `1,${pages}`).split(',').map(Number))];
  if (!comparisonPages.length || comparisonPages.some(p=>!Number.isSafeInteger(p)||p<1||p>pages)) throw new Error('Invalid comparison pages');
  const resumeCheck = process.argv.includes('--compact-resume');
  const verifyExisting = process.argv.includes('--verify-existing');
  if(verifyExisting&&!resumeRoot)throw new Error('Existing verification needs local persisted fixture');
  const fixtures = ['ALPHA','BETA'].slice(0, docCount).map(name => ({ name, file:path.join(root,`${name}.pdf`), codes:Array.from({length:pages},()=>randomBytes(3).toString('hex').toUpperCase()) }));
  if (resumeRoot) {
    for (const fixture of fixtures) {
      fixture.codes = JSON.parse(execFileSync('python3',['-c',
        'import fitz,re,json,sys; d=fitz.open(sys.argv[1]); print(json.dumps([re.search(r"Verification code: ([A-F0-9]{6})",p.get_text()).group(1) for p in d]))',fixture.file],{encoding:'utf8'}));
      if (fixture.codes.length !== pages) throw new Error('Resume fixture size mismatch');
    }
  }
  for (const fixture of resumeRoot ? [] : fixtures) {
    execFileSync('python3',['-c',`import fitz,json\nf=json.loads(${JSON.stringify(JSON.stringify(fixture))})\nd=fitz.open()\nfor i,code in enumerate(f['codes']):\n p=d.new_page(width=595,height=420)\n p.insert_text((50,70), f['name']+' PAGE '+str(i+1),fontsize=24)\n p.insert_text((50,140),'Verification code: '+code,fontsize=22)\n p.insert_text((50,200),'Synthetic public fixture. Read every page.',fontsize=16)\nd.save(f['file'])`]);
  }
  const registry = new PiModelRegistryManager();
  const runtime = await registry.getModelRuntime();
  const modelId = process.env.PDF_CANARY_MODEL || 'smartest';
  const model = runtime.getModel('litellm-responses', modelId);
  if (!model || !model.input.includes('image')) throw new Error('Configured vision model unavailable');
  const system = 'Analyze only the synthetic PDFs provided. Read every requested page through pdf_view; follow coverage.nextCall without asking for continuation. After each batch emit a short textual finding before the next tool calls. Never infer unseen page codes. Final answer must list document, page and verification code. Requery original pages for comparisons. Do not call any external tools.';
  const resources: ResourceLoader = {
    getExtensions:()=>({extensions:[],errors:[],runtime:createExtensionRuntime()}),
    getSkills:()=>({skills:[],diagnostics:[]}), getPrompts:()=>({prompts:[],diagnostics:[]}),
    getThemes:()=>({themes:[],diagnostics:[]}), getAgentsFiles:()=>({agentsFiles:[]}),
    getSystemPrompt:()=>system, getSystemPromptSource:()=>undefined,
    getAppendSystemPrompt:()=>[], getAppendSystemPromptSources:()=>[], extendResources:()=>{}, reload:async()=>{},
  };
  const observations: Array<{source:string;pages:number[];remaining:number[];batchId?:string}> = [];
  const underlying = createPdfViewTool({cwd:root, projectRoot:root, sessionId:'synthetic-local-pdf-canary'});
  let toolCalls=0;
  const tool = {...underlying, execute:async (...args:any[]) => {
    if (++toolCalls > pages * 4 + 12) throw new Error('CANARY_TOOL_CALL_LIMIT');
    const result:any=await (underlying.execute as any)(...args);
    const c=result.details?.coverage;
    if(c) observations.push({source:c.source,pages:c.deliveredPages,remaining:c.remainingPages,batchId:result.details.visualReference?.batchId});
    return result;
  }};
  const requests: Array<{bytes:number;imageItems:number}> = [];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async (input,init) => {
    const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
    if (/\/responses(?:\?|$)/.test(url) && typeof init?.body==='string') {
      let count=0;
      JSON.stringify(JSON.parse(init.body),(_key,value)=>{if(value?.type==='input_image')count++;return value;});
      requests.push({bytes:Buffer.byteLength(init.body),imageItems:count});
      if (requests.length>pages * 4 + 16) throw new Error('CANARY_REQUEST_LIMIT');
    }
    return originalFetch(input,init);
  };
  installPiProviderSafeguards();
  const settingsManager=SettingsManager.inMemory({compaction:{enabled:false,keepRecentTokens:2048,reserveTokens:4096},retry:{enabled:false,maxRetries:0}});
  const sessionDir=path.join(root,'sessions');
  const sessionFiles=resumeRoot?(await fs.readdir(sessionDir)).filter(f=>f.endsWith('.jsonl')):[];
  if(resumeRoot&&sessionFiles.length!==1)throw new Error('Ambiguous synthetic session');
  const sessionManager=resumeRoot?SessionManager.open(path.join(sessionDir,sessionFiles[0]),sessionDir,root)
    :resumeCheck?SessionManager.create(root,sessionDir):SessionManager.inMemory(root);
  if(resumeRoot) {
    for(const item of sessionManager.getEntries() as any[]) {
      const message=item.message;const c=message?.details?.coverage;
      if(message?.role==='toolResult'&&!message.isError&&c)observations.push({source:c.source,pages:c.deliveredPages,remaining:c.remainingPages,batchId:message.details.visualReference?.batchId});
    }
  }
  const newSession=async (manager: SessionManager) => (await createAgentSession({cwd:root,agentDir:path.join(root,'agent'),model,modelRuntime:runtime,
    resourceLoader:resources,tools:['pdf_view'],customTools:[tool],sessionManager:manager,settingsManager,thinkingLevel:'off'})).session;
  let session=await newSession(sessionManager);
  let state = new PdfObservationState();
  const projections: Array<{ omittedPdfMessages:number; imageItems:number }> = [];
  const usage:any[]=[];
  const attachHooks=()=> {
    session.setActiveToolsByName(['pdf_view']);
    if (!session.getActiveToolNames().includes('pdf_view')) throw new Error('CANARY_PDF_TOOL_NOT_ACTIVE');
    state=new PdfObservationState();
    state.bindPersistence(session.sessionManager.getBranch().filter((item:any)=>item.type==='custom'&&item.customType===PDF_OBSERVATION_ENTRY).map((item:any)=>item.data),
      record=>session.sessionManager.appendCustomEntry(PDF_OBSERVATION_ENTRY,record));
    session.agent.beforeToolCall=state.beforeToolCall;
    session.agent.finishTurn=state.finishTurn;
    session.agent.prepareNextTurn=state.prepareNextTurn as any;
    installPiVisualContextTransform(session.agent,state);
    const nativeProjection=session.agent.transformContext;
    session.agent.transformContext=async(messages,signal)=>{
      const projected=nativeProjection?await nativeProjection(messages,signal):messages;
      projections.push({omittedPdfMessages:projected.filter((message:any)=>Array.isArray(message.content)&&message.content.some((part:any)=>part.type==='text'&&part.text?.includes('PDF pixels omitted'))).length,
        imageItems:projected.reduce((sum:number,message:any)=>sum+(Array.isArray(message.content)?message.content.filter((part:any)=>part.type==='image').length:0),0)});
      return projected;
    };
    session.subscribe((event:any)=>{if(event.type==='message_end'&&event.message?.role==='assistant'){
      usage.push({stopReason:event.message.stopReason,usage:event.message.usage});state.observe([...session.agent.state.messages,event.message]);
    }});
  };
  attachHooks();
  const timer=setTimeout(()=>session.abort(),Math.min(1800000,240000+pages*15000));
  let compactionResume:any={requested:resumeCheck,passed:!resumeCheck};
  let report:any;
  try {
    const completedReceipts=session.sessionManager.getBranch().filter((item:any)=>item.type==='custom'&&item.customType===PDF_OBSERVATION_ENTRY).map((item:any)=>item.data);
    const unfinished=fixtures.map(f=>({path:f.file,pages:Array.from({length:pages},(_,i)=>i+1).filter(page=>!completedReceipts.some((r:any)=>r.source===f.file&&r.pages?.includes(page)))}));
    if(!verifyExisting) await session.prompt(resumeRoot ? `Continue the interrupted synthetic reading from these unrecorded pages: ${JSON.stringify(unfinished)}. Do not repeat earlier recorded pages unless needed. Use existing observation notes for earlier codes. Finish all pages then list every page code from 1 to ${pages}. Do not claim completion before covering them all.` : `Read every page of the provided documents and report the verification code printed on each page. Start by viewing the provided files.\n${fixtures.map(f=>f.file).join('\n')}`);
    const first=stripPdfObservationText(session.getLastAssistantText()||'');
    const firstObservationCount=observations.length;
    const firstPass=!state.completionIncomplete && verifyPdfCanaryPages({fixtures,pages:Array.from({length:pages},(_,i)=>i+1),observations,answer:first}) && fixtures.every(f=>Array.from({length:pages},(_,i)=>i+1).every(page=>observations.some(o=>o.source===f.file && o.pages.includes(page))));
    const coverageComplete=fixtures.every(f=>Array.from({length:pages},(_,i)=>i+1).every(page=>observations.some(o=>o.source===f.file&&o.pages.includes(page))));
    if (!coverageComplete || (!firstPass&&!verifyExisting)) throw new Error('CANARY_INCOMPLETE_READING');
    if (resumeCheck && coverageComplete) {
      const receiptsBefore=session.sessionManager.getBranch().filter((item:any)=>item.type==='custom'&&item.customType===PDF_OBSERVATION_ENTRY).length;
      const compactionsBefore=session.sessionManager.getEntries().filter((item:any)=>item.type==='compaction').length;
      const file=session.sessionManager.getSessionFile();
      if(!file)throw new Error('CANARY_SESSION_NOT_PERSISTED');
      await session.compact('Preserve synthetic document source paths, page coverage and observation receipt references. Do not infer unseen page codes.');
      const compactionsAfter=session.sessionManager.getEntries().filter((item:any)=>item.type==='compaction').length;
      session.dispose();
      session=await newSession(SessionManager.open(file,sessionDir,root));
      attachHooks();
      const receiptsAfter=session.sessionManager.getBranch().filter((item:any)=>item.type==='custom'&&item.customType===PDF_OBSERVATION_ENTRY).length;
      compactionResume={requested:true,passed:compactionsAfter>compactionsBefore&&receiptsBefore>0&&receiptsBefore===receiptsAfter,
        compactionsBefore,compactionsAfter,receiptsBefore,receiptsAfter,mode:'native manual compaction + dispose/open at completed turn; not mid-tool abort'};
    }
    await session.prompt(`Reopen pages ${comparisonPages.join(", ")} of the provided PDFs using pdf_view at dpi 300. Inspect each glyph carefully; do not rely on your prior answer. Report document/page/code in a table. Do not add unrelated pages.`);
    const comparison=stripPdfObservationText(session.getLastAssistantText()||'');
    const comparisonObs=observations.slice(firstObservationCount);
    const receiptRecords=session.sessionManager.getBranch().filter((item:any)=>item.type==='custom'&&item.customType===PDF_OBSERVATION_ENTRY).map((item:any)=>item.data);
    const receiptIds=new Set(receiptRecords.map((record:any)=>record?.batchId));
    const receiptPageCoverageComplete=fixtures.every(f=>Array.from({length:pages},(_,i)=>i+1).every(page=>receiptRecords.some((record:any)=>record.source===f.file&&record.pages?.includes(page))));
    const historicalUnrecordedBatches=observations.filter(o=>o.pages.length&&!receiptIds.has(o.batchId)).map(o=>({source:o.source,pages:o.pages,batchId:o.batchId}));
    const finalReceiptsComplete=!state.completionIncomplete && observations.filter(o=>o.pages.length).every(o=>receiptIds.has(o.batchId));
    const comparisonPass=verifyPdfCanaryPages({fixtures,pages:comparisonPages,observations:comparisonObs,answer:comparison});
    report={scope:'local SDK + live configured inference + synthetic PDFs; no browser or deployed session',
      runMode:verifyExisting?'verify-existing':resumeRoot?'resume-reading':'fresh-reading',
      firstPassMeaning:verifyExisting?'prior-last-answer-only; not a new full-reading verdict':'current full-reading answer',
      status:firstPass&&comparisonPass&&finalReceiptsComplete&&compactionResume.passed?'PASS':'FAIL',model:{provider:model.provider,id:model.id},pagesPerDocument:pages,documentCount:docCount,coverageComplete,firstPass,comparisonPass,comparisonPages,finalReceiptsComplete,receiptPageCoverageComplete,historicalUnrecordedBatches,compactionResume,
      observations,requests,projections,usage,firstAnswer:first,comparisonAnswer:comparison,
      visibleMarkersAbsent:!first.includes('[PDF observation')&&!comparison.includes('[PDF observation'),
      unverified:['production proxy replay',...(resumeCheck?['automatic overflow recovery','mid-tool interruption']:['long-session compaction']),'expired/revoked attachment requery','high-detail Korean/table quality']};
  } catch(error) {
    // No raw provider body/credentials in evidence.
    report={status:'BLOCKED',errorCode:error instanceof Error&&error.message.startsWith('CANARY_')?error.message:undefined,scope:'live synthetic canary',reason:error instanceof Error?error.name:'UnknownError',compactionResume,observations,requests,projections,usage};
  } finally {clearTimeout(timer);session.dispose();globalThis.fetch=originalFetch;}
  const reportPath=path.join(root,resumeRoot?`resume-${attempt}-report.json`:'report.json');
  await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,firstPass:report.firstPass,comparisonPass:report.comparisonPass,compactionResume:report.compactionResume,
    toolCalls,projectedPdfReferences:Math.max(0,...projections.map(p=>p.omittedPdfMessages)),providerRequests:requests.length,maxRequestBytes:Math.max(0,...requests.map(r=>r.bytes)),evidence:reportPath}));
  if(report.status!=='PASS')process.exitCode=1;
}
main().catch(error=>{console.error(`CANARY_SETUP_FAILED: ${error instanceof Error?error.name:'UnknownError'}`);process.exitCode=1;});
