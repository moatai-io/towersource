import { snapshotFile, type FileSnapshot } from './file-checkpoint.js';
import { ensureTurnCheckpoint, recordCheckpointFileChange } from './file-checkpoint-repo.js';

export interface PendingFileCheckpointCapture {
  checkpointId: string;
  projectRoot: string;
  filePath: string;
  toolName: string;
  before: FileSnapshot;
}

/** Capture before synchronously before the mutating tool runs. */
export async function beginFileCheckpointCapture(params: {
  rootTurnId: string;
  sessionId: string;
  projectRoot: string;
  filePath: string;
  toolName: string;
}): Promise<PendingFileCheckpointCapture> {
  const before = await snapshotFile(params.projectRoot, params.filePath);
  const checkpointId = await ensureTurnCheckpoint({ rootTurnId: params.rootTurnId, sessionId: params.sessionId });
  return { checkpointId, projectRoot: params.projectRoot, filePath: params.filePath, toolName: params.toolName, before };
}

/** Persist only after tool success; repeated edits keep the first before in SQL. */
export async function completeFileCheckpointCapture(capture: PendingFileCheckpointCapture): Promise<void> {
  const after = await snapshotFile(capture.projectRoot, capture.filePath);
  await recordCheckpointFileChange({
    checkpointId: capture.checkpointId,
    filePath: capture.filePath,
    toolName: capture.toolName,
    before: capture.before,
    after,
  });
}

export async function markTurnCheckpointPartial(params: { rootTurnId: string; sessionId: string }): Promise<void> {
  await ensureTurnCheckpoint({ ...params, partial: true });
}
