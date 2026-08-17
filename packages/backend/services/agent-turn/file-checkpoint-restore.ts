import { applyFilesOnlyRestore } from './file-checkpoint.js';
import { loadCheckpointFileChanges, recordRestoreRun } from './file-checkpoint-repo.js';
import { previewCheckpointRestore } from './file-checkpoint-preview.js';

export async function applyConfirmedCheckpointRestore(params: {
  checkpointId: string;
  projectRoot: string;
  requestedBy: number;
  paths?: string[];
  previewHash: string;
  confirmed: boolean;
}): Promise<{ restoredPaths: string[] }> {
  if (params.confirmed !== true) throw new Error('checkpoint_restore_confirmation_required');
  const allChanges = await loadCheckpointFileChanges(params.checkpointId);
  const selected = params.paths?.length ? allChanges.filter((c) => params.paths!.includes(c.filePath)) : allChanges;
  if (params.paths?.length && selected.length !== new Set(params.paths).size) throw new Error('checkpoint_paths_not_found');

  try {
    await applyFilesOnlyRestore({ projectRoot: params.projectRoot, changes: selected, previewHash: params.previewHash });
    await recordRestoreRun({ checkpointId: params.checkpointId, requestedBy: params.requestedBy, status: 'applied', previewHash: params.previewHash, selectedPaths: selected.map((c) => c.filePath), conflicts: [] });
    return { restoredPaths: selected.map((c) => c.filePath) };
  } catch (error) {
    const message = (error as Error).message;
    const status = message === 'checkpoint_restore_conflict' || message === 'checkpoint_preview_stale' ? 'conflict' : 'failed';
    await recordRestoreRun({ checkpointId: params.checkpointId, requestedBy: params.requestedBy, status, previewHash: params.previewHash, selectedPaths: selected.map((c) => c.filePath), conflicts: [], error: message });
    throw error;
  }
}

export { previewCheckpointRestore };
