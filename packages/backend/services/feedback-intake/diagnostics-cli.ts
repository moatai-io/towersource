import { diagnoseFeedback } from './diagnostics.js';
import { connectDiagnosticPg } from './diagnostics-pg.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--config-only')) throw new Error();
  const result = await diagnoseFeedback(process.env, connectDiagnosticPg, { database: args[0] !== '--config-only' });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
main().catch(() => {
  // Invalid invocation/internal failures only. Missing config/tables/off states
  // are normal diagnostic JSON responses, not activation or deployment failures.
  process.stderr.write('feedback_diagnostics_failed\n');
  process.exitCode = 1;
});
