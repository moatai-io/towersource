/** Run with tsx. Only a bounded, secret-free JSON evidence document on stdin. */
import { prepareProvisionPlan } from './provision-plan.js';

async function main() {
  if (process.argv.slice(2).some(a => a !== '--dry-run')) throw new Error();
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 16384) throw new Error();
    chunks.push(Buffer.from(chunk));
  }
  const result = prepareProvisionPlan(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
main().catch(() => {
  // Never serialize input, validation exceptions, environment or provider errors.
  process.stderr.write('feedback_provision_plan_invalid_or_apply_not_supported\n');
  process.exitCode = 1;
});
