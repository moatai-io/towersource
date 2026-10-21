/**
 * Owns: conservative capacity-unit classification for transient Worker Runs.
 * Public API: classifyWorkbenchWorkerCapacityWeight.
 */
import type { WorkbenchExecutionLifecycle, WorkbenchExecutionRequest } from '../execution/execution-broker.js';

/**
 * Estimate host pressure without inspecting Project data. Services use the separate
 * systemd pool budget and therefore reserve no transient units here.
 */
export function classifyWorkbenchWorkerCapacityWeight(
  request: Pick<WorkbenchExecutionRequest, 'command'>,
  lifecycle: WorkbenchExecutionLifecycle,
): number {
  if (lifecycle === 'service') return 0;
  const command = request.command.toLowerCase();
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|compile|bundle)\b|\b(tsc|vite build|next build|nix build|cargo build|gradle build|mvn package)\b/.test(command)) return 3;
  if (/\b(playwright|puppeteer|chromium|chrome|vitest|jest|pytest|pandoc|libreoffice|soffice|ffmpeg)\b|\b(pdf|pptx|docx)\b/.test(command)) return 2;
  return 1;
}
