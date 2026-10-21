import {startCentralServices} from './central-service-entry.js';
/** Dedicated operator-installed central process. Never launched by customer Tower main. */
const file=process.env.TOWER_CENTRAL_SERVICE_CONFIG;if(!file)throw Error('TOWER_CENTRAL_SERVICE_CONFIG required');
const services=await startCentralServices(file,process.env);
let stopping=false;async function stop(){if(stopping)return;stopping=true;await services.close();process.exit(0);}
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
