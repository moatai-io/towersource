/** Explicit path-mode opt-in; legacy deployments retain existing subdomain URLs. */
export function publishedSiteUrl(slug:string,appBase:string|undefined,publishingBase?:string):string|undefined {
 if(!/^[a-z0-9][a-z0-9-]*$/.test(slug))throw Error('publishing_slug_invalid');
 if(publishingBase){
  const u=new URL(publishingBase);
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||u.port)throw Error('publishing_base_invalid');
  if(appBase&&new URL(appBase).origin===u.origin)throw Error('publishing_app_origin_shared');
  return new URL(slug+'/',u).href;
 }
 if(!appBase)return undefined;const u=new URL(appBase);return `${u.protocol}//${slug}.${u.host}/`;
}
