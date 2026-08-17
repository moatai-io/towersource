---
title: "Getting Started"
icon: "🚀"
order: 1
---

# Getting Started

> Tower is an AI command center for teams. Chat with AI, collaborate with teammates, manage files, and automate tasks -- all in one place.

---

## What is Tower?

Tower is a web platform that lets your team use Claude AI together. From private AI conversations (Sessions) to team channels (Channels), file management, and task automation, everything happens in a single screen.

Think of it as your team's shared AI workspace -- where individual productivity and team collaboration meet.

---

## Screen Layout

Tower is divided into three panels:

<svg viewBox="0 0 600 300" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="600" height="300" rx="8" fill="#1a1a2e" stroke="#333" stroke-width="2"/>
  <rect x="10" y="10" width="130" height="280" rx="6" fill="#16213e" stroke="#444" stroke-width="1"/>
  <text x="75" y="150" text-anchor="middle" fill="#8b8fa3" font-size="14" font-family="sans-serif">Sidebar</text>
  <rect x="150" y="10" width="280" height="280" rx="6" fill="#0f3460" stroke="#444" stroke-width="1"/>
  <text x="290" y="150" text-anchor="middle" fill="#e2e8f0" font-size="14" font-family="sans-serif">Center Panel</text>
  <rect x="440" y="10" width="150" height="280" rx="6" fill="#16213e" stroke="#444" stroke-width="1"/>
  <text x="515" y="150" text-anchor="middle" fill="#8b8fa3" font-size="14" font-family="sans-serif">Context Panel</text>
</svg>

### Sidebar (Left)

The Sidebar is your navigation hub. Switch between views using the tabs:

| Tab | What it shows |
|-----|---------------|
| **Sessions** | Your private AI conversation list |
| **Channel** | Team channel list |
| **Files** | File tree browser |

At the bottom of the Sidebar you will find:

- **Pins** -- Quick access to favorited sessions and files
- **History** -- Recent activity log
- **Settings** -- Personal preferences

### Center Panel (Middle)

The main content area changes based on your active tab:

- Sessions tab -- Chat interface (ChatPanel)
- Channel tab -- Team conversation (RoomPanel)
- Kanban icon in Header -- Task board

### Context Panel (Right)

Opens when you click a file. What you see depends on the file type:

- Code files -- Syntax-highlighted editor
- Markdown -- Rendered preview
- PDF -- Document viewer
- Images / Videos -- Media preview

---

## Creating Your First Session

1. Select the **Sessions** tab in the Sidebar.
2. Click the **+ button** at the top.
3. A new Session opens with the input box focused and ready.

A Session is your private conversation space with Claude AI. Create as many as you need -- one per topic works best.

---

## Sending Your First Message

1. Type your message in the input box at the bottom.
2. Press **Enter** to send.
3. AI streams its response in real time -- you will see text appear as it is generated.

Need a line break? Use **Shift + Enter** instead of Enter.

### Attaching Files

You can send files along with your message:

| Method | How |
|--------|-----|
| **Drag and drop** | Drag a file onto the input box |
| **Clipboard paste** | Press Ctrl+V to paste a screenshot or image |
| **From File Tree** | Drag a file from the Sidebar file tree to the input box |

Attached files are sent to AI with your message. Images, PDFs, code files, and more are supported.

---

## The Project Concept

A Project is Tower's core organizing unit. It groups related Sessions, Channels, Files, and Tasks together.

### What a Project does

- Organizes Sessions by topic or team
- Auto-creates a dedicated file folder under `workspace/projects/`
- Provides AI with project context (via `AGENTS.md`)
- When you invite someone to a project, they get access to everything in it

### Creating a Project

1. Click the project dropdown at the top of the Sidebar.
2. Select **+ New Project**.
3. Enter a name -- your project is ready.

A dedicated folder is automatically created at `workspace/projects/<your-project-name>/`.

---

## Next Steps

- Deep-dive into AI conversations -- [Sessions](./02-sessions.md)
- Collaborate with your team -- [Channels](./03-channels.md)
- Manage your files -- [Files](./04-files.md)
- Automate work with AI -- [Tasks](./05-tasks.md)
- Explore visual outputs -- [Visual Blocks](./06-visual-blocks.md)
