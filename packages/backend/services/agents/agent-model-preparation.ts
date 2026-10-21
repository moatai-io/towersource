/** Harness-owned adapter seam. Not enabled in production until cancellable, metered runner exists. */
export interface ModelPreparationRunner {
  harnessId: string;
  model: string;
  capabilities: readonly string[];
  maxInputChars: number;
  maxOutputChars: number;
  timeoutMs: number;
  run(input: string, signal: AbortSignal): Promise<string>;
}
export async function runBoundedModelPreparation(input: string, runner: ModelPreparationRunner): Promise<{question: string | null; plan: string; hypotheses: string[]}> {
  if (!runner.harnessId || !runner.model || runner.capabilities.length || runner.maxInputChars > 16000 || runner.maxOutputChars > 4000 || runner.timeoutMs > 30000 || runner.timeoutMs <= 0) throw new Error('Unsafe preparation runner contract');
  if (input.length > runner.maxInputChars) throw new Error('Preparation input limit exceeded');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race([
      runner.run(input, controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Preparation timeout')); }, runner.timeoutMs); }),
    ]);
    if (output.length > runner.maxOutputChars) throw new Error('Preparation output limit exceeded');
    const value = JSON.parse(output);
    if (Object.keys(value).some(k => !['question','plan','hypotheses'].includes(k)) || !(value.question === null || typeof value.question === 'string') || typeof value.plan !== 'string' || !Array.isArray(value.hypotheses) || value.hypotheses.some((v: unknown) => typeof v !== 'string')) throw new Error('Invalid preparation output');
    return value;
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}
