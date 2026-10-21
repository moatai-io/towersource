// The agent_end error timeout belongs to the failed request, not to the
// assistant/tool run that may follow a successful SDK overflow compaction.
export function resetPiOverflowSettleAfterCompaction(params: {
  pending: boolean;
  compactionSucceeded: boolean;
  terminalForced: boolean;
  clearClosingTimer: () => void;
  clearAgentEndTimer: () => void;
  armPostCompactTimer: () => void;
}): boolean {
  if (!params.pending || !params.compactionSucceeded || params.terminalForced) return false;
  params.clearClosingTimer();
  params.clearAgentEndTimer();
  params.armPostCompactTimer();
  return true;
}

export function releasePiOverflowSettleAfterAssistant(params: {
  pending: boolean;
  compactionSucceeded: boolean;
  role?: string;
  stopReason?: string;
  clearClosingTimer: () => void;
  clearAgentEndTimer: () => void;
}): boolean {
  if (!params.pending || !params.compactionSucceeded || params.role !== 'assistant'
    || (params.stopReason !== 'toolUse' && params.stopReason !== 'stop')) return false;
  params.clearClosingTimer();
  params.clearAgentEndTimer();
  return true;
}
