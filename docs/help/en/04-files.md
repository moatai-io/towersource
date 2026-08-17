---
title: "Files"
icon: "📁"
order: 4
---

# Files

> Navigate your project files in the File Tree, preview and edit in the Context Panel, and share with a link. All from the same screen.

---

## File Tree

Select the **Files** tab in the Sidebar to open the file tree.

### Basic Navigation

- **Click a folder** -- expand or collapse it
- **Click a file** -- open it in the Context Panel
- Nested folders can be explored freely

### File Icon Colors

File types are color-coded for quick recognition:

| Color | File type |
|-------|-----------|
| Blue | TypeScript (.ts, .tsx) |
| Yellow | JavaScript (.js, .jsx) |
| Green | Python (.py) |
| Red | HTML (.html) |
| Purple | CSS (.css, .scss) |
| Gray | Config files (.json, .yaml, .toml) |

---

## Hidden Files

By default, files starting with `.` (like `.env`, `.gitignore`) are hidden.

- Click the **hidden files toggle** at the top of the File Tree to show or hide them
- Commonly hidden directories like `node_modules` and `.git` are also controlled by this toggle

---

## Context Menu (Right-Click)

Right-click a file or folder to open the context menu.

### File Menu Options

| Option | Description |
|--------|-------------|
| **New File** | Create a new file at the current location |
| **New Folder** | Create a new folder at the current location |
| **Rename** | Rename the file or folder (Enter to confirm, Escape to cancel) |
| **Delete** | Delete the file or folder (with confirmation) |
| **Share** | Generate a shareable link |
| **Download** | Download the file |
| **Copy Path** | Copy the file path to clipboard |

### Folder Menu

Right-clicking a folder shows the same options plus the ability to create new files and folders inside it.

---

## File Upload

### Drag and Drop to Folders

1. Select files in your file explorer (Finder, Explorer, etc.)
2. Drag them over the target folder in the File Tree
3. When the drop zone highlights, release
4. Upload complete

You can drag multiple files at once for batch upload.

### Drag to Input Box for Attachment

Drag files onto the Session or Channel input box to attach them to your message. This is the fastest way to ask AI to analyze or modify a file.

You can also drag files from the File Tree directly to the input box.

---

## Context Panel

Click a file to open it in the Context Panel on the right side of the screen.

### File Type Behavior

| File type | Context Panel behavior |
|-----------|----------------------|
| **Code files** (.ts, .py, .js, etc.) | Syntax-highlighted code editor |
| **Markdown** (.md) | Rendered preview (including Mermaid diagrams) |
| **PDF** (.pdf) | PDF viewer |
| **Images** (.png, .jpg, .gif, etc.) | Image preview |
| **Video** (.mp4, .webm, etc.) | Video player |
| **Other** | Plain text display |

### Code Editing

You can edit and save files directly in the Context Panel's code editor. Changes are written to disk immediately.

---

## File Sharing

Share files with people outside Tower:

1. Right-click a file -- select **Share**
2. A shareable link is generated
3. Copy the link and send it

Anyone with the link can access the file without logging in.

---

## Pin Feature

Pin frequently accessed files for one-click access.

### Adding a Pin

- Right-click a file -- select **Pin**
- Or click the Pin icon at the top of the Context Panel

### Viewing Pins

Click the **Pins** button at the bottom of the Sidebar to see all pinned files and sessions in one place.

---

## Tips

- **Copy Path for AI**: When asking AI to work on a file, right-click it, copy the path, and paste it into your message. Much more accurate than describing the file location.
- **Markdown preview**: Write documentation and see the rendered result in real time.
- **File Tree to input box**: Drag files from the tree to the input box -- it is the fastest way to ask AI about a specific file.
- **Check hidden files**: When you cannot find a config file like `.env` or `.eslintrc`, toggle hidden files on.
- **Pin your essentials**: Pin 5-6 core project files and your workflow speeds up significantly.
