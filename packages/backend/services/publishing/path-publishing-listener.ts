import type {Server} from 'node:http';import path from 'node:path';import {pathPublishingApp} from './path-publishing-app.js';
/** Disabled unless both explicit base URL and loopback listener port are installed. */
export async function startPathPublishingListener(env:NodeJS.ProcessEnv,workspaceRoot:string):Promise<Server|undefined>{
 if(!env.TOWER_PATH_PUBLISHING_PORT&&!env.TOWER_PUBLISHING_BASE_URL)return undefined;
 const port=Number(env.TOWER_PATH_PUBLISHING_PORT);if(!Number.isInteger(port)||port<1024||port>65535||!env.TOWER_PUBLISHING_BASE_URL)throw Error('path_publishing_listener_config_invalid');
 const u=new URL(env.TOWER_PUBLISHING_BASE_URL);if(u.protocol!=='https:'||u.port||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('path_publishing_listener_config_invalid');
 const app=pathPublishingApp({hostname:u.hostname,sitesRoot:path.join(workspaceRoot,'published/sites'),manifestPath:path.join(workspaceRoot,'published/manifest.json')});
 return await new Promise<Server>((resolve,reject)=>{const server=app.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve(server);});server.once('error',reject);});
}
