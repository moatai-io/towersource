import { runProvisionLauncher, launcherConfigSchema } from './provision-launcher.js';
import { readConfig, verifySelfLocation } from './provision-runtime.js';
async function main(){
  if(process.argv[2]!=='--config'||!process.argv[3])throw new Error();
  const c=launcherConfigSchema.parse(JSON.parse(readConfig(process.argv[3]).toString()));
  verifySelfLocation(c.manifestPath,import.meta.url);
  const result=await runProvisionLauncher(process.argv[3],process.argv.slice(4));
  process.stdout.write(JSON.stringify(result)+'\n');
}
main().catch(()=>{process.stderr.write('feedback_provision_launcher_refused\n');process.exitCode=1;});
