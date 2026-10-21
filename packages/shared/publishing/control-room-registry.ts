export interface ControlRoomEntry {slug:string;title:string;format?:'html';entry?:string}
export function parseControlRegistry(value:unknown):ControlRoomEntry[]{
 const x=value as {version?:unknown;dashboards?:unknown};
 if(!x||x.version!==1||!Array.isArray(x.dashboards)||x.dashboards.length>100)throw Error('registry');
 const seen=new Set<string>();
 return x.dashboards.map((v:unknown)=>{const e=v as ControlRoomEntry;if(!e||typeof e.slug!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(e.slug)||seen.has(e.slug)||typeof e.title!=='string'||!e.title.trim()||e.title.length>120)throw Error('entry');seen.add(e.slug);if(e.format!==undefined&&e.format!=='html')throw Error('format');if(e.format==='html'){if(typeof e.entry!=='string'||!/^site\/[a-zA-Z0-9_-]+\.html$/.test(e.entry))throw Error('entry');return {slug:e.slug,title:e.title,format:e.format,entry:e.entry}}if(e.entry!==undefined)throw Error('entry');return {slug:e.slug,title:e.title};});
}
/** Preserves unmodified raw entries/metadata. Existing different slugs are never silently replaced. */
export function addControlRoomEntry(content:string,entry:ControlRoomEntry):string{
 parseControlRegistry({version:1,dashboards:[entry]});
 const raw=JSON.parse(content);const entries=parseControlRegistry(raw);const old=entries.find(e=>e.slug===entry.slug);
 if(old){if(JSON.stringify(old)!==JSON.stringify(parseControlRegistry({version:1,dashboards:[entry]})[0]))throw Error('registration_conflict');return content;}
 if(entries.length>=100)throw Error('registry_full');
 return JSON.stringify({...raw,dashboards:[...raw.dashboards,entry]},null,2)+'\n';
}
