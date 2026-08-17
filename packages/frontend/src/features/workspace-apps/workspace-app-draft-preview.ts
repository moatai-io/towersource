import type { WorkspaceAppDefinition, WorkspaceAppBuilderDraftChange } from './workspace-app-definition';

function applyDraftChange(definition: WorkspaceAppDefinition, change: WorkspaceAppBuilderDraftChange): WorkspaceAppDefinition {
  const next = {
    ...definition,
    tableView: {
      ...definition.tableView,
      columns: definition.tableView.columns.map((column) => ({ ...column })),
      rows: definition.tableView.rows,
    },
    builder: definition.builder,
  };

  if (change.path === 'title') return { ...next, title: change.after };
  if (change.path === 'description') return { ...next, description: change.after };
  if (change.path === 'tableView.title') return { ...next, tableView: { ...next.tableView, title: change.after } };
  if (change.path === 'tableView.subtitle') return { ...next, tableView: { ...next.tableView, subtitle: change.after } };

  const columnLabelMatch = change.path.match(/^tableView\.columns\[(\d+)\]\.label$/);
  if (columnLabelMatch) {
    const columnIndex = Number(columnLabelMatch[1]);
    if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= next.tableView.columns.length) return definition;
    const columns = next.tableView.columns.map((column, index) => index === columnIndex ? { ...column, label: change.after } : column);
    return { ...next, tableView: { ...next.tableView, columns } };
  }

  return definition;
}

export function applyWorkspaceAppDraftPreview(definition: WorkspaceAppDefinition, enabled: boolean): WorkspaceAppDefinition {
  if (!enabled || !definition.builder.draftPreview?.changes.length) return definition;
  return definition.builder.draftPreview.changes.reduce(applyDraftChange, definition);
}
