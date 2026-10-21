export type BrowserCanaryReport = { status: 'PASS'|'FAIL'|'BLOCKED'; scope: 'browser-file-api'; path?: string; checks: string[]; retained: boolean; unverified: string[]; failure?: string };
export async function runBrowserFileCanary(root: string, request: (url:string, init?:RequestInit)=>Promise<Response>): Promise<BrowserCanaryReport> {
 const report: BrowserCanaryReport={status:'BLOCKED',scope:'browser-file-api',checks:[],retained:false,unverified:['worker-execution','viewer-render','download','tool-cli','negative-acl']};
 if(!root.startsWith('/') || root.includes('\0') || root.split('/').includes('..')) return report;
 const nonce=crypto.randomUUID();const file=`${root.replace(/\/$/,'')}/tower-canary-${nonce}.txt`;report.path=file;
 let stage='create';
 const call=async(url:string,body?:object)=>{
  const res=await request(url,body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {cache:'no-store'});
  if(!res.ok)throw Error('HTTP_FAILED');const data=await res.json();
  if(data.storageAuthority!=='host')throw Error('NOT_CANONICAL');return data;
 };
 try{
  // Retain the uniquely named file: generic delete API cannot atomically assert
  // file identity/content and could recursively delete a concurrently replaced directory.
  report.retained=true;
  await call('/api/files/create',{path:file,content:`${nonce}:1`});report.checks.push('create');
  stage='read-first';if((await call(`/api/files/read?path=${encodeURIComponent(file)}`)).content!==`${nonce}:1`)throw Error('MISMATCH');report.checks.push(stage);
  stage='update';await call('/api/files/write',{path:file,content:`${nonce}:2`});report.checks.push(stage);
  stage='read-updated';if((await call(`/api/files/read?path=${encodeURIComponent(file)}`)).content!==`${nonce}:2`)throw Error('MISMATCH');report.checks.push(stage);
  report.status='PASS';
 }catch{report.status='FAIL';report.failure=stage;}
 return report;
}
