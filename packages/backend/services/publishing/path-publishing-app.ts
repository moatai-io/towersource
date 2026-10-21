import express from 'express';import path from 'node:path';import fs from 'node:fs/promises';
/** Dedicated Publishing listener only. Never mount this on the authenticated Tower app origin. */
export function pathPublishingApp(input:{hostname:string;sitesRoot:string;manifestPath:string}){
 if(!/^[a-z0-9][a-z0-9-]*\.publish\.(?:tower\.example\.org|tower\.example\.com)$/.test(input.hostname)||!path.isAbsolute(input.sitesRoot)||!path.isAbsolute(input.manifestPath))throw Error('path_publishing_config_invalid');
 const app=express();app.disable('x-powered-by');app.set('trust proxy',false);
 app.use(async(req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  if(req.headers.host!==input.hostname||!['GET','HEAD'].includes(req.method))return res.sendStatus(404);
  let decoded:string;try{decoded=decodeURIComponent(req.path);}catch{return res.sendStatus(404);}
  if(decoded.split('/').some(x=>x==='.'||x==='..'||x.startsWith('.'))||decoded.includes('\\')||decoded.includes('\0'))return res.sendStatus(404);
  const slug=decoded.split('/')[1];if(!/^[a-z0-9][a-z0-9-]*$/.test(slug??''))return res.sendStatus(404);
  try{
   const manifest=JSON.parse(await fs.readFile(input.manifestPath,'utf8'));const site=Array.isArray(manifest.sites)?manifest.sites.find((x:any)=>(x.slug??x.name)===slug):undefined;
   if(!site||site.archived||site.archived_at||!['public','unlisted'].includes(site.access))return res.sendStatus(404);
   const root=await fs.realpath(input.sitesRoot);const folder=path.join(root,slug);
   // Never follow site symlinks into customer workspaces on this public listener.
   if((await fs.lstat(folder)).isSymbolicLink())return res.sendStatus(404);
   const real=await fs.realpath(folder);if(!real.startsWith(root+path.sep))return res.sendStatus(404);
   const relative=decoded.split('/').slice(2).join('/');const asset=path.join(real,relative||'index.html');
   const resolved=await fs.realpath(asset);if(!resolved.startsWith(real+path.sep))return res.sendStatus(404);
   if(!(await fs.stat(resolved)).isFile())return res.sendStatus(404);
   if(decoded==='/'+slug)return res.redirect(308,'/'+slug+'/');
   res.setHeader('Cache-Control','no-cache');return res.sendFile(resolved,{dotfiles:'deny'});
  }catch{return res.sendStatus(404);}
 });
 return app;
}
