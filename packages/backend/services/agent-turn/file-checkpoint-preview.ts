import { previewFilesOnlyRestore, type RestorePreview } from './file-checkpoint.js';
import { loadCheckpointFileChanges, recordRestoreRun } from './file-checkpoint-repo.js';

export async function previewCheckpointRestore(params: {
  checkpointId: string;
  projectRoot: string;
  requestedBy: number;
  paths?: string[];
}): Promise<RestorePreview> {
  const allChanges = await loadCheckpointFileChanges(params.checkpointId);
  const selected = params.paths?.length
    ? allChanges.filter((change) => params.paths!.includes(change.filePath))
    : allChanges;
  if (params.paths?.length && selected.length !== new Set(params.paths).size) {
    throw new Error('checkpoint_paths_not_found');
  }
  const preview = await previewFilesOnlyRestore(params.projectRoot, selected);
  await recordRestoreRun({
    checkpointId: params.checkpointId,
    requestedBy: params.requestedBy,
    status: preview.canApply ? 'previewed' : 'conflict',
    previewHash: preview.previewHash,
    selectedPaths: selected.map((change) => change.filePath),
    conflicts: preview.items.filter((item) => item.status === 'conflict'),
  });
  return preview;
}
