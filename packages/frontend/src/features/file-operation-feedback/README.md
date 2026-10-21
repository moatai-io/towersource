# File operation feedback

Feature-owned policy for file saves and uploads. This is not a configurable toast
wrapper: owners report outcomes and supply a stable surface/path key; the module
owns sanitization, presentation and lifetime.

## Contract

- Save operations await HTTP success, serialize concurrent submissions per path,
  preserve edits on failure, and never automatically replay uncertain writes.
- Successful save acknowledgement only marks matching submitted content clean.
  Later edits and another active file must not be overwritten by late responses.
- Personal Space keeps its existing expectedVersion concurrency check. Conflict,
  permission and network failures keep content dirty and show a safe inline notice.
- Failures persist until dismissed or replaced by a later outcome. Successful
  save status clears after three seconds of viewing; pending saves cannot be
  dismissed. No feedback is persisted to a transcript or sent as raw server text.
- Upload failure exposes counts and allowlisted permission/quota categories only.
  Partial success must not replay the entire batch. Users inspect the file list
  and reselect missing files through the existing upload control. Upload success
  retains the existing success toast; transfer progress remains at its owner.
- General settings/Credential saves, file creation/rename/delete, resumable UploadPanel
  transfer control, and backend error/request correlation are outside this module.

## Integration

`saveFileOperation` is used by App prompt saves, useChatRuntime project-file saves,
usePersonalViewerActions and FileViewerPage. Project-file saves use the existing
`POST /api/files/write` ACL-protected endpoint instead of the generic WebSocket
error channel. Existing backend routes and authorization are unchanged.

`FileOperationFeedback` renders in ContextPanel, FileViewerPage, FilesWorkspace,
FileTree, Sidebar, SidebarProjectFiles, InputBox and MarkdownEditor. Project and
attachment scopes include project/session identity. Legacy sidebar uploads share
one sidebar surface; each mounted file tree owns an isolated scope.

`utils/upload-notice.ts` is a compatibility adapter: it forwards failure facts to
this owner and preserves success toasts. It no longer owns a duplicate error policy.

## Verification

- `feedback.test.tsx`: surface isolation, dismissal, HTTP rejection, ambiguous
  network failure, explicit retry, duplicate-save exclusion, success lifetime,
  and save acknowledgement with newer edits/another active file.
- `integration.source.test.ts`: save entry points and upload owner wiring.
- `utils/upload-notice.test.ts`: partial failures, sanitized reasons, success/empty.
- Existing personal viewer, sidebar, input upload and runtime source tests remain
  regression evidence, not substitutes for browser/live-server verification.

No deployment or real backend restart is performed by these local tests.

## Responsibility split and follow-up cleanup

- `save-operation.ts` owns awaited writes and concurrent-save exclusion.
- `save-acknowledgement.ts` owns submitted-content comparison against editor state.
- `feedback.ts` owns surface state and domain outcome reporting.
- `messages.ts` owns upload reason sanitization and known-failure wording.
- `FileOperationFeedback.tsx` owns presentation and visible success lifetime.

Tree scopes are now per mounted tree instance (`useId`) and explicitly propagated
into nested trees/drop targets. Project/session consumers use `uploadScope` rather than hand-built strings.
The sidebar's two remaining multipart upload implementations now call the same
`uploadDroppedFiles` transport owner, preserving result details where available.

Confirmed per-file results use `reportUploadFailure`; transport exceptions and
unreadable results use `reportUploadUnknown`, without invented failure counts.
Legacy `file_saved` frames cannot safely acknowledge content and are ignored by
the current frontend. All current save entry points await their HTTP response.
No backend protocol or ACL changes are included.
