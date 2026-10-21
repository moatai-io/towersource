---
title: "Files — Artifacts and Delivery"
icon: "📁"
order: 4
---

# Files — artifacts and delivery

Showing source material to AI, keeping it in a Project, and delivering it to another place are separate actions. Specify the intended scope to avoid unnecessary copies or sharing.

## Project files and Viewer

Browse files and folders through Files. Selecting a supported file opens a preview or editor in the right-side Viewer. Available actions depend on the file type and your permissions.

Use the relevant screen's menu for creating files or folders, renaming, copying paths, or downloading. Confirm targets before deletion, overwriting, or bulk changes. Read-only access does not permit editing.

After AI creates an artifact, check its **filename and actual saved path**. Saving a file, requesting Viewer presentation, and delivering a copy are distinct operations.

## Storage locations

Prefer the Project's existing structure. If it uses `sources/`, `work/`, `final/`, and `records/`, separate originals, drafts, final outputs, and evidence accordingly. Do not create a competing folder scheme for every task.

| Location | Purpose and boundary |
|---|---|
| Conversation attachment | Temporary material for the conversation; permanent storage is a separate choice |
| Project files | Source material and artifacts governed by the Project's access and write permissions |
| Personal Space | A personal copy, separate from the Project |
| Another AI teammate's Project | An explicitly delivered copy to an accessible destination |
| Published site | A separate publishing and access policy, not ordinary Project file access |

## Attachments and originals

Attach documents and images for analysis. PDF and Office support depends on installed tools and Skills.

“Read and summarize this” does not automatically authorize permanent storage of the original attachment. Ask explicitly to keep it in the Project. Saving a converted output and preserving its source are separate decisions.

## Revise an existing file

> Update only the conclusion in `final/report.md`. Preserve the other sections and revise the same file.

Name the file and the content to preserve. Multiple Sessions and support AI in one Project can affect the same files. Assign editing ownership and check current content before applying changes.

## Deliver files

Ask AI to attach an existing Project file to the current conversation, or copy it to Personal Space or another accessible AI teammate's Project. Specify and confirm the exact destination for another storage location.

> Attach the finished PDF to this conversation.

> Copy this one final report to the specified AI teammate's Project. Preserve the source and do not overwrite existing files.

Delivery normally copies rather than moves or deletes the source. Directory delivery may enforce file-count and symbolic-link limits and does not overwrite existing files. Unsupported source and destination combinations may be rejected.

Where drag-and-drop or delivery menus are available, they use the supported transfer path. A rename or move inside a file tree is different from delivery between storage locations.

## Sharing and publishing

A file path or link does not grant Project access. Publishing a web page is a separate action for a different audience.

Before publishing, confirm the readers, content, and access level. An **unlisted link is not authenticated secret storage**. Anyone who receives a usable link may be able to view the content; exclude secrets, Credentials, and private material. See [Visual outputs](./06-visual-outputs.md).

## Final checks

- Verify the actual saved path.
- Inspect tables, fonts, and pages in the final output.
- Distinguish local validation from successful publishing or delivery.
- Decide separately what to share and which original material to retain.
