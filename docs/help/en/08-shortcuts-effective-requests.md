---
title: "Shortcuts and Effective Requests"
icon: "⌨️"
order: 8
---

# Shortcuts and Effective Requests

Keyboard shortcuts help with frequent actions, but a precise request has a larger effect on output quality.

## Confirmed keyboard behavior

### Message composer

| Action | Shortcut |
|---|---|
| Send a message | `Enter` |
| Add a new line | `Shift+Enter` |
| Accept an inline suggestion | `Tab` |
| Close a suggestion or temporary input state | `Esc` |

When an input method editor is composing Korean, Japanese, or Chinese text, Tower avoids treating the composition confirmation as a separate send action.

### Viewer Pane

| Action | Shortcut |
|---|---|
| Save the active editable file | `Ctrl+S` or `Cmd+S` |
| Close the active file tab | `Ctrl+W` or `Cmd+W` |
| Move to the next file tab | `Ctrl+Tab` |
| Move to the previous file tab | `Ctrl+Shift+Tab` |
| Move through file-tab history | `Alt+Left` or `Alt+Right` |

Browser or operating-system shortcuts can take precedence in some environments.

### Mermaid preview

When the Mermaid preview is focused or expanded:

| Action | Shortcut |
|---|---|
| Fit diagram | `0` |
| Show at 100% | `1` |
| Zoom | `+` or `-` |
| Pan | arrow keys or drag |
| Close expanded view | `Esc` |

## Write an effective request

Include the information that would materially change the result.

### 1. Name the outcome

Instead of:

> Review this.

Use:

> Review this proposal and identify the three issues most likely to block approval.

### 2. Name the audience

> Write for a non-technical executive who has five minutes to decide whether to fund the project.

Audience changes vocabulary, evidence, detail, and call to action.

### 3. Specify the artifact

> Save a standalone Markdown report under `final/` and open it in the Viewer Pane.

If you need a PDF, DOCX, Excel file, static site, or editable source, say so.

### 4. State constraints

Useful constraints include:

- required or forbidden sources;
- length or page count;
- language;
- privacy and permission boundaries;
- whether external actions are allowed;
- whether uncertain claims must be labeled;
- whether the AI may edit files or should only recommend changes.

### 5. Give acceptance criteria

> The result is complete when every recommendation names the affected file, expected impact, and verification method.

Evidence-checkable criteria reduce vague completion claims.

## Continue related work in one Session

Use the same Session when the goal, source material, and decisions are still related. Start a new Session when the topic or audience has materially changed, or when a separate workstream needs its own durable history.

## Attachments and files

An uploaded attachment is temporary unless you explicitly save it to Personal Space or the Project. Analysis does not automatically mean the file should be persisted.

For existing Project files, provide the path or open the file before asking for a change. For generated artifacts, ask Tower to report the final path.

## Protected actions

Inspection, diagnosis, and planning do not automatically authorize deployment, deletion, purchase, external messaging, or other protected writes.

If you want an external action, name the target and expected effect. Tower may still ask for confirmation immediately before execution.

## Example request

> Compare the current English installation guide with the actual package scripts and `.env.example`. Update only public documentation. Do not change runtime code or deployment scripts. Preserve existing local edits from other Sessions. Validate every relative link and report changed files and remaining uncertainty.
