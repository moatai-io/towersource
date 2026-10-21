/** A selected directory/sidebar introduction is not an entered Workspace. */
export function resolveEnteredWorkspace(input: {
  activeView: string;
  systemTabKind: string | null;
  systemProjectId: string | null;
  activeSessionProjectId: string | null;
  capabilityProjectId: string | null;
}): string | null {
  if (input.activeView === 'projectFiles') return input.capabilityProjectId;
  if (input.activeView !== 'chat') return null;
  if (input.systemTabKind === 'projectFiles') return input.systemProjectId;
  if (input.systemTabKind) return null;
  return input.activeSessionProjectId;
}
