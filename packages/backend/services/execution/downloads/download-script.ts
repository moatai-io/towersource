/** Runs inside the existing Project executor. No provider credentials are injected. */
export const DOWNLOAD_SCRIPT = String.raw`
import os,sys,json,time,socket,hashlib,urllib.request,urllib.error,ipaddress,tempfile,random
cfg=json.loads(sys.argv[1]); root=os.path.realpath(os.getcwd()); target=os.path.realpath(os.path.join(root,cfg['destination']))
class Blocked(Exception): pass
def fail(code): raise Blocked(code)
if os.path.commonpath([root,target])!=root or target==root: fail('DESTINATION_OUTSIDE_PROJECT')
part=target+'.part'; checkpoint=target+'.download.json'; lock=target+'.download.lock'
state={'phase':'connecting','bytesReceived':0,'bytesWritten':0,'attempt':0,'observedAt':time.time(),'lastByteAt':None,'lastDiskGrowthAt':None,'rangeAccepted':None,'errorCode':None,'nextAction':None,'idleTimeoutSec':cfg['idleTimeoutSec']}
def emit():
 state['observedAt']=time.time()
 fd,tmp=tempfile.mkstemp(dir=os.path.dirname(target),prefix='.download-')
 with os.fdopen(fd,'w') as f: json.dump(state,f)
 os.replace(tmp,checkpoint)
 print('TOWER_DOWNLOAD_PROGRESS '+json.dumps(state,separators=(',',':')),flush=True)
def validate_url(url):
 from urllib.parse import urlsplit
 u=urlsplit(url)
 if u.scheme!='https' or not u.hostname or u.username or u.password: fail('UNSAFE_URL')
 for info in socket.getaddrinfo(u.hostname,u.port or 443,type=socket.SOCK_STREAM):
  if not ipaddress.ip_address(info[4][0]).is_global: fail('UNSAFE_URL')
 return url
class Redirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,url):
  validate_url(url)
  return super().redirect_request(req,fp,code,msg,headers,url)
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),Redirect())
# Validate every actual DNS resolution too, not only preflight (DNS rebinding).
resolve=socket.getaddrinfo
def public_resolve(*args,**kwargs):
 results=resolve(*args,**kwargs)
 for info in results:
  if not ipaddress.ip_address(info[4][0]).is_global: fail('UNSAFE_URL')
 return results
socket.getaddrinfo=public_resolve
import signal
def interrupted(signum,frame): fail('CANCELLED_OR_TERMINATED')
signal.signal(signal.SIGTERM,interrupted); signal.signal(signal.SIGINT,interrupted)
lockfd=None
try:
 os.makedirs(os.path.dirname(target),exist_ok=True)
 if any(os.path.islink(p) for p in (part,checkpoint,lock)): fail('UNSAFE_DESTINATION_SYMLINK')
 lockfd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
 os.write(lockfd,str(os.getpid()).encode())
 if os.path.exists(target): fail('DESTINATION_EXISTS')
 old={}
 if os.path.exists(checkpoint):
  with open(checkpoint) as f: old=json.load(f)
  for key in ('sourceFingerprint','validator','totalBytes','sha256','expectedBytes','md5'): state[key]=old.get(key)
 source=hashlib.sha256(cfg['url'].encode()).hexdigest()
 if os.path.exists(part) and os.path.getsize(part)>0 and (old.get('sourceFingerprint')!=source ): fail('RESUME_METADATA_REQUIRED')
 if old.get('sha256')!=cfg.get('sha256') or old.get('md5')!=cfg.get('md5') or old.get('expectedBytes')!=cfg.get('expectedBytes'):
  if os.path.exists(part) and os.path.getsize(part)>0: fail('RESUME_METADATA_CHANGED')
 state.update({'md5':cfg.get('md5'),'sha256':cfg.get('sha256'),'expectedBytes':cfg.get('expectedBytes'),'sourceFingerprint':source,'validator':old.get('validator'),'totalBytes':old.get('totalBytes')})
 socket.setdefaulttimeout(cfg['connectTimeoutSec']); validate_url(cfg['url'])
 for attempt in range(1,cfg['maxAttempts']+1):
  state['attempt']=attempt; offset=os.path.getsize(part) if os.path.exists(part) else 0
  state.update({'bytesWritten':offset,'phase':'connecting','errorCode':None,'nextAction':None}); emit()
  try:
   headers={ 'Accept-Encoding':'identity' }
   fallback=bool(offset and not state['validator'])
   if fallback and (cfg.get('expectedBytes') is None or not (cfg.get('sha256') or cfg.get('md5'))): fail('RESUME_CHECKSUM_REQUIRED')
   start=max(0,offset-65536) if fallback else offset
   if offset:
    headers['Range']='bytes=%d-'%start
    if state['validator']: headers['If-Range']=state['validator']
   state['resumeMethod']='overlap_and_checksum' if fallback else 'validator' if offset else 'initial'
   with opener.open(urllib.request.Request(cfg['url'],headers=headers),timeout=cfg['connectTimeoutSec']) as response:
    state['httpStatus']=response.status; state['rangeAccepted']=response.status==206
    validator=response.headers.get('ETag')
    if validator and validator.startswith('W/'): validator=None
    validator=validator or response.headers.get('Last-Modified')
    if offset:
     import re
     match=re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',response.headers.get('Content-Range',''))
     if response.status!=206 or not match or int(match[1])!=start or int(match[2])<offset or int(match[2])>=int(match[3]): fail('RANGE_MISMATCH')
     if not fallback and validator!=state['validator']: fail('REMOTE_CHANGED')
     total=int(match[3])
     if state.get('totalBytes') and total!=state['totalBytes']: fail('REMOTE_CHANGED')
    else:
     if response.status!=200: fail('UNEXPECTED_HTTP_STATUS')
     total=int(response.headers['Content-Length']) if response.headers.get('Content-Length') else None
    state['validator']=validator; state['totalBytes']=total
    if cfg.get('expectedBytes') is not None and total is not None and total!=cfg['expectedBytes']: fail('SIZE_MISMATCH')
    expected=cfg.get('expectedBytes') if cfg.get('expectedBytes') is not None else total
    import shutil
    if expected is not None and shutil.disk_usage(os.path.dirname(target)).free<max(0,expected-offset): fail('DISK_FULL')
    response.fp.raw._sock.settimeout(cfg['idleTimeoutSec'])
    if fallback:
     state['phase']='verifying_resume'; emit()
     remaining=offset-start; overlap=b''
     while remaining:
      block=response.read1(remaining)
      if not block: raise ConnectionError('SHORT_OVERLAP')
      overlap+=block; remaining-=len(block); state['bytesReceived']+=len(block); state['lastByteAt']=time.time()
     with open(part,'rb') as existing:
      existing.seek(start)
      if existing.read(offset-start)!=overlap: fail('RESUME_OVERLAP_MISMATCH')
    state['phase']='transferring'; emit(); lastemit=time.monotonic()
    with open(part,'ab') as out:
     while True:
      data=response.read1(1024*1024)
      if not data: break
      state['bytesReceived']+=len(data); state['lastByteAt']=time.time()
      out.write(data); out.flush(); state['bytesWritten']=out.tell(); state['lastDiskGrowthAt']=time.time()
      if expected is not None and out.tell()>expected: fail('SIZE_MISMATCH')
      if time.monotonic()-lastemit>=2: emit(); lastemit=time.monotonic()
     os.fsync(out.fileno())
    if expected is not None and state['bytesWritten']!=expected: raise ConnectionError('SHORT_RESPONSE')
   break
  except Blocked: raise
  except urllib.error.HTTPError as e:
   if e.code not in (408,429,500,502,503,504): fail('HTTP_'+str(e.code))
   state['errorCode']='HTTP_'+str(e.code)
  except (TimeoutError,socket.timeout): state['errorCode']='BODY_STALLED' if state['phase']=='transferring' else 'CONNECT_OR_HEADERS_TIMEOUT'
  except (urllib.error.URLError,ConnectionError): state['errorCode']='NETWORK_OR_SHORT_RESPONSE'
  if attempt==cfg['maxAttempts']: fail(state['errorCode'])
  state.update({'phase':'retry_wait','nextAction':'Waiting for bounded retry; partial file preserved.'}); emit()
  time.sleep(min(30,2**attempt)+random.random())
 state['phase']='verifying'; emit()
 if cfg.get('sha256') or cfg.get('md5'):
  algorithm='sha256' if cfg.get('sha256') else 'md5'
  state['checksumAlgorithm']=algorithm
  digest=hashlib.new(algorithm)
  lastemit=time.monotonic()
  with open(part,'rb') as f:
   for block in iter(lambda:f.read(1024*1024),b''):
    digest.update(block)
    if time.monotonic()-lastemit>=2: emit(); lastemit=time.monotonic()
  if digest.hexdigest()!=cfg[algorithm]: fail('CHECKSUM_MISMATCH')
  state['checksumVerified']=True
 else: state['checksumVerified']=False
 # Atomic no-overwrite finalization, including another writer creating the destination.
 os.link(part,target); os.unlink(part)
 state.update({'phase':'completed','errorCode':None,'nextAction':None}); emit()
except FileExistsError:
 state.update({'phase':'blocked','errorCode':'LOCK_OR_DESTINATION_EXISTS','nextAction':'Inspect destination/lock owner; never delete partial data automatically.'})
 print('TOWER_DOWNLOAD_PROGRESS '+json.dumps(state),flush=True); sys.exit(1)
except Exception as e:
 code=str(e) if isinstance(e,Blocked) else ('DISK_FULL' if isinstance(e,OSError) and e.errno==28 else 'PERMISSION_DENIED' if isinstance(e,PermissionError) else 'IO_OR_PROTOCOL_ERROR')
 state.update({'phase':'blocked','errorCode':code,'nextAction':'Partial file preserved. Fix the reported condition, then start the same download to resume. Verify metadata before restarting from zero.'})
 if lockfd is not None: emit()
 else: print('TOWER_DOWNLOAD_PROGRESS '+json.dumps(state),flush=True)
 sys.exit(1)
finally:
 if lockfd is not None:
  os.close(lockfd); os.unlink(lock)
`;
