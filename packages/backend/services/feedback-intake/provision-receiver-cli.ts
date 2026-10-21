import { receiveProvision } from './provision-receiver.js';
import { boundedInput, readConfig, receiverBindingSchema, verifySelfLocation } from './provision-runtime.js';

async function main(){
  if(process.argv.length!==4 || process.argv[2]!=='--binding')throw new Error();
  const binding=receiverBindingSchema.parse(JSON.parse(readConfig(process.argv[3]).toString()));
  verifySelfLocation(binding.manifestPath,import.meta.url);
  const input=await boundedInput(process.stdin);
  try{process.stdout.write(JSON.stringify(await receiveProvision(process.argv[3],input))+'\n');}
  finally{input.fill(0);}
}
main().catch(()=>{process.stderr.write('feedback_provision_receiver_refused\n');process.exitCode=1;});
