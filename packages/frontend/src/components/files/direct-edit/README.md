# direct-edit (frontend)

Source-backed direct editing for file previews.

## Responsibility

- Let supported Markdown/HTML preview text become cursor-editable.
- Patch only the corresponding source text range.
- Mark the file dirty through the existing file-store / FileViewerPage save flow.

## Boundaries

- Does not call AI.
- Does not write to disk directly.
- Does not attempt full WYSIWYG structural editing.
- Ambiguous source matches are rendered read-only.

## Related

- `docs/plans/2026-06-04-preview-direct-edit.md`
- `components/files/inline-edit/` remains the preserved AI rewrite module.
