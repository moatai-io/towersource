/**
 * Current domain-facing executor selection API.
 * The implementation remains behind the historical Workbench compatibility module during migration.
 */
export {
  requiredWorkbenchWorkerCapabilities as requiredWorkerExecutorCapabilities,
  selectPersistedWorkbenchExecutionProvider as selectProjectExecutionProvider,
} from '../runtime-box/workbench-execution-provider-selector.js';
export type {
  WorkbenchProviderSelectionInput as ProjectExecutorSelectionInput,
  RemoteWorkbenchBinding as LegacyRemoteWorkerBinding,
} from '../runtime-box/workbench-execution-provider-selector.js';
