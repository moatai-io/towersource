/** Fixed customer receiver protocol. Standalone CLI in provision-receiver-cli.ts. */
import { localCustomerAdapter } from './provision-customer.js';
import { readConfig, receiverBindingSchema, requestSchema, bindHash, productionChecks,
  verifyManifest, verifyLocalHost, type LocalChecks } from './provision-runtime.js';
import { refuse } from './provision-files.js';

export async function receiveProvision(bindingPath: string, input: Buffer, checks: LocalChecks = productionChecks) {
  try {
    if(input.length>8192)refuse();
    const raw=readConfig(bindingPath,checks);const binding=receiverBindingSchema.parse(JSON.parse(raw.toString()));
    const req=requestSchema.parse(JSON.parse(input.toString()));const hash=bindHash(raw);
    if(req.bindingHash!==hash)refuse();
    verifyManifest(binding.manifestPath,binding.revision,checks);verifyLocalHost(binding.host,binding.uid);
    const adapter=localCustomerAdapter({...binding,observeIdentity:()=>{verifyLocalHost(binding.host,binding.uid);return {host:binding.host,uid:binding.uid};},checkAncestors:checks.ancestors});
    if(req.action==='inspect')return {status:'inspected',bindingHash:hash,snapshot:await adapter.inspect(req.token,binding.origin)};
    if(req.planHash!==binding.planHash || req.preimage!==binding.preimage || req.origin!==binding.origin
      || req.host!==binding.host || req.uid!==binding.uid || req.envPath!==binding.envPath)refuse();
    const {action:_action,bindingHash:_bindingHash,...append}=req;
    const bytes=Buffer.from(JSON.stringify({version:1,...append}));
    try{await adapter.appendStdin(bytes);}finally{bytes.fill(0);}
    return {status:'appended',bindingHash:hash};
  }catch{refuse();}
}
