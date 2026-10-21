// Shadow-only adapter pinned to the installed Vitest API. No test execution.
import { createVitest } from 'vitest/node';
import path from 'node:path';
export async function discoverRelated(files) {
  const ctx = await createVitest('test', { watch: false, related: files.map(file => path.resolve(file)) });
  try {
    if (!ctx.specifications?.getRelevantTestSpecifications) throw Error('Unsupported Vitest discovery API; shadow selection unavailable');
    const specs = await ctx.specifications.getRelevantTestSpecifications();
    return specs.map(spec => spec.moduleId);
  } finally { await ctx.close(); }
}
