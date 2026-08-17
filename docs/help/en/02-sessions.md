---
title: "Sessions — AI Chat"
icon: "💬"
order: 2
---

# Sessions -- AI Chat

> A Session is your private conversation space with Claude AI. Ask questions, write code, analyze files, and request complex tasks.

---

## What is a Session?

A Session is a 1-on-1 conversation thread with AI. While Channels are shared team spaces, Sessions are your personal workspace.

Each Session maintains its own conversation context. You can have multiple Sessions open and organize them by topic.

---

## Creating a New Session

### Basic creation

1. Select the **Sessions** tab in the Sidebar.
2. Click the **+ button** at the top.
3. A new Session opens with the input box focused.

### Creating within a Project

When you create a Session while a Project is selected, the Session belongs to that project. The project's AI settings (`AGENTS.md`) are automatically applied.

---

## Sending Messages

| Action | Shortcut |
|--------|----------|
| Send message | **Enter** |
| Line break (new line) | **Shift + Enter** |
| Stop streaming | **Escape** |
| Cancel queued message | **Escape** |

### Streaming

When you send a message, AI streams its response in real time. You will see text appear character by character as it is generated.

### Message Queueing

If you send additional messages while AI is still responding, they enter a **queue**. Once the current response finishes, queued messages are sent in order.

- Queued messages appear above the input box
- Press **Escape** to cancel a queued message
- Press **Escape** during streaming to stop the current response

This means you never have to wait -- just keep typing your follow-up questions.

---

## Slash Commands

Type `/` in the input box to open the command menu. Slash commands let you trigger specific actions quickly. Browse the list or type to filter by name.

---

## File Attachments

You can send files to AI along with your message.

### How to attach

| Method | Description |
|--------|-------------|
| **Drag and drop** | Drag a file onto the input box |
| **Clipboard paste** | Paste a screenshot or image with Ctrl+V |
| **From File Tree** | Drag a file from the Sidebar file tree to the input box |

Attached files are sent to AI with your message. Supported formats include images, PDFs, code files, and more.

---

## Session Management

### Renaming

Click a Session's name in the list to rename it. Give it a descriptive name that matches the conversation topic -- it makes sessions much easier to find later.

### Favorites (Pin)

Pin frequently used Sessions for quick access:

- Right-click a Session -- select **Pin**
- View all pinned items in the **Pins** section at the bottom of the Sidebar

### Deleting

Remove Sessions you no longer need:

- Right-click a Session -- select **Delete**
- Deleted Sessions cannot be recovered

### Moving Between Projects

You can move a Session to a different project:

- Right-click a Session -- select **Move to Project**
- Choose the target project

---

## Turn Metrics

Each AI response shows turn metrics at the bottom.

| Metric | Description |
|--------|-------------|
| **Token count** | Input/output tokens used in this turn |
| **Model** | The AI model that generated the response |
| **Duration** | Time taken to generate the response |

Monitoring token usage helps you manage costs effectively.

---

## Draft Auto-Save

Whatever you type in the input box is automatically saved per session.

- Switch to another Session -- your draft is preserved
- Close and reopen the browser -- your draft is still there
- Sending a message clears that Session's draft

You will never lose a long message because you accidentally switched tabs or closed the browser.

---

## Tips

- **One topic per Session**: Do not mix multiple subjects in a single Session. AI understands context better when conversations are focused.
- **Use Projects**: Assigning Sessions to projects lets AI automatically reference project settings.
- **Queue your questions**: Do not wait for AI to finish -- send follow-up questions immediately. They are processed in order.
- **Attach files directly**: Instead of saying "analyze this code," drag the file into the input box for more accurate results.
