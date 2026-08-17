# Uploads service decisions

- Keep uploaded project materials out of git. They are workspace inputs, not source history.
- Use resumable chunk uploads for large folders instead of increasing single-request body limits.
- Use project-local staging under `uploads/.staging/` so ACL, cleanup, and AI file references remain project-scoped.
- Start with local disk storage. Object storage is a later backend adapter only if customers use Tower as a recurring archive.
- Use DB metadata rather than manifest-only files so server restarts can resume and cleanup can be reliable.
- Do not block project uploads by extension. Folder uploads are workspace inputs, so `.sh`, `.exe`, `.bak`, and similar names should be stored inertly; later execution, preview, and publishing paths carry the stronger safety checks.
