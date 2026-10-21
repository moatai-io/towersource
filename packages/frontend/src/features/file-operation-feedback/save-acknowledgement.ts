import { useFileStore } from '../../stores/file-store';

/** A save acknowledgement must not mark edits made during the request as saved. */
export function acknowledgeFileSave(path: string, content: string) {
  const state = useFileStore.getState();
  const tab = state.tabs.find(tab => tab.path === path);
  if (tab?.content === content) state.markTabSavedByPath(path);
  if (state.openFile?.path === path && state.openFile.content === content) state.markSaved();
}
