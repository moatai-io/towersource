# Tower Skill Package Specification

Complete reference for Tower skill package authoring. Tower uses managed/project skill sources; legacy provider-specific skill folders are compatibility inputs only.

---

## File Structure

```
skill-name/
├── SKILL.md           # Required: Main skill instructions
├── supporting.md      # Optional: Detailed reference
├── examples.md        # Optional: Usage examples
└── scripts/           # Optional: Helper scripts
    └── helper.py
```

**Tower Location Priority / SSOT:**
1. Current session prompt injection / explicitly mounted project skill
2. Project Runtime Box materialized skills: `/workspace/.tower/skills/<name>/`
3. Personal/project DB-backed skills exposed by Tower backend
4. Tower repo managed source/catalog: `skills/managed/<name>/` + `config/skills/managed-skills.yaml`
5. Legacy `.claude` skill folders — compatibility/fallback only, not managed source/catalog SSOT

---

## SKILL.md Format

Two mandatory parts separated by `---`:

```markdown
---
# YAML Frontmatter (configuration)
name: skill-name
description: What it does and when to use it
---

# Markdown Content (instructions)
Instructions the Tower AI agent follows when the skill is active...
```

---

## Frontmatter Reference

### Required/Recommended Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | No* | string | Slash command name. If omitted, uses directory name. |
| `description` | Recommended | string | What + when. Used for auto-invocation. |

*If `name` is omitted, directory name becomes the command.

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `context` | string | `immediate` | `fork` runs in isolated subagent |
| `agent` | string | — | Subagent type when `context: fork` |
| `allowed-tools` | string/array | all | Tools available without permission prompts |
| `model` | string | session | Override model for this skill |
| `disable-model-invocation` | boolean | `false` | Prevent Claude auto-invoking |
| `user-invocable` | boolean | `true` | Show in `/` menu |
| `argument-hint` | string | — | Autocomplete hint |
| `slash-aliases` / `aliases` | array/string | — | Extra slash command aliases exposed through Tower command registry |
| `hooks` | object/string | — | Skill-scoped hooks |

---

## Field Specifications

### `name`
```yaml
name: my-skill-name
```
- Lowercase alphanumeric and hyphens only
- Maximum 64 characters
- Cannot contain XML tags
- **Cannot contain reserved words**: `anthropic`, `claude`
- Becomes `/my-skill-name` command
- Must match directory name if specified
- **Naming convention**: Prefer gerund form (`processing-pdfs`) over noun form (`pdf-processor`)

### `description`
```yaml
description: Generate API documentation. Use when documenting endpoints or creating OpenAPI specs.
```
- **Must be non-empty**
- **Maximum 1024 characters**
- **Cannot contain XML tags**
- **Always write in third person** ("Processes files" not "I process files" or "You can use this")
- Include WHAT it does
- Include WHEN to use it (triggers auto-invocation)
- Use keywords users would naturally say

### `context`
```yaml
context: fork
```
- `immediate` (default): Runs inline in current conversation
- `fork`: Runs in isolated subagent context

**Use `fork` for:**
- Complex multi-step tasks
- Tasks needing fresh context
- Research/investigation skills

**Use `immediate` for:**
- Reference content
- Guidelines and conventions
- Skills needing conversation history

### `agent`
```yaml
context: fork
agent: Explore
```
Requires `context: fork`. Options:
- `Explore` - Read-only codebase exploration
- `Plan` - Planning and architecture
- `general-purpose` - Full capabilities
- Custom subagent profiles are Tower runtime-specific; do not point new skills at provider config-home agent files.

### `allowed-tools`
```yaml
# String format
allowed-tools: Read, Glob, Grep

# Array format
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash(git:*)
```

**Valid Tools:**
| Tool | Description |
|------|-------------|
| `Bash` | Shell command execution |
| `Read` | Read files |
| `Write` | Create/overwrite files |
| `Edit` | Edit existing files |
| `Glob` | File pattern matching |
| `Grep` | Content search |
| `WebSearch` | Web search |
| `WebFetch` | Fetch URL content |
| `Task` | Spawn subagent |
| `Skill` | Invoke other skills |
| `NotebookEdit` | Edit Jupyter notebooks |

**Tool Patterns:**
```yaml
allowed-tools:
  - Bash(git:*)      # Only git commands
  - Bash(npm:*)      # Only npm commands
  - Bash(pnpm:*)     # Only pnpm commands
```

### `disable-model-invocation`
```yaml
disable-model-invocation: true
```
- Prevents the AI agent from auto-invoking
- User must manually invoke with `/skill-name`
- Description NOT included in the AI agent context

**Use for:**
- Deploy/release commands
- Commit/push commands
- Send message commands
- Any side-effect operations

### `user-invocable`
```yaml
user-invocable: false
```
- Hides skill from `/` menu
- The AI agent can still invoke it
- Description IS included in context

**Use for:**
- Background knowledge
- Domain conventions
- Guidelines without explicit invocation

### `argument-hint`
```yaml
argument-hint: "[issue-number]"
argument-hint: "[filename] [format]"
```
- Shown in autocomplete UI
- Helps users understand expected input

### `slash-aliases` / `aliases`
```yaml
# Optional: add at most one Korean alias when it clearly helps users.
slash-aliases:
  - /회의준비
```
- Exposed in Tower slash command autocomplete and backend canonical dispatch
- Optional; canonical `/<name>` is already the default slash command
- Prefer no alias when the English skill name is clear enough
- If needed, add only one Korean alias; avoid multiple aliases because they clutter the picker
- Must not conflict with existing skill/native/workflow commands
- Self-service skill authoring should add skill aliases only; do not create `.tower/commands/*.command.yaml` unless a separate workflow-command design is explicitly requested

### `model`
```yaml
model: claude-opus-4-5
```
- Override session model for this skill
- Use for skills requiring specific capabilities

---

## String Substitutions

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` | All arguments passed to skill |
| `$ARGUMENTS[N]` | Access a specific argument by 0-based index, such as `$ARGUMENTS[0]` for the first argument |
| `$N` | Shorthand for `$ARGUMENTS[N]`, such as `$0` for the first argument or `$1` for the second |
| `${TOWER_SESSION_ID}` | Current Tower session identifier. Useful for logging, creating session-specific files, or correlating skill output with sessions |

**Example:**
```yaml
---
name: fix-issue
argument-hint: "[issue-number]"
---

Fix GitHub issue $ARGUMENTS following our standards.
```

Invocation: `/fix-issue 123` → "Fix GitHub issue 123 following..."

**Example using indexed arguments:**
```yaml
---
name: migrate-component
description: Migrate a component from one framework to another
argument-hint: "[component] [from-framework] [to-framework]"
---

Migrate the $0 component from $1 to $2.
Preserve all existing behavior and tests.
```

Invocation: `/migrate-component SearchBar React Vue` replaces `$0` with `SearchBar`, `$1` with `React`, `$2` with `Vue`.

If `$ARGUMENTS` not in content, appended as `ARGUMENTS: <value>`.

---

## Dynamic Context Injection

Run shell commands before sending context to the AI agent:

```markdown
## Current state
- Branch: !`git branch --show-current`
- Status: !`git status --short`
- Recent commits: !`git log --oneline -5`
```

Commands execute immediately, output replaces placeholder.

---

## marketplace.json Schema

### Top-Level Structure

```json
{
  "name": "marketplace-name",
  "version": "1.0.0",
  "description": "Marketplace description",
  "author": "author-name",
  "repository": "https://github.com/org/repo",
  "plugins": [...]
}
```

### Required Fields
- `name` - Kebab-case identifier
- `plugins` - Array of plugin entries

### Plugin Entry Structure

```json
{
  "name": "plugin-name",
  "description": "Plugin description",
  "source": "./",
  "skills": [
    "./skills/skill-one",
    "./skills/skill-two"
  ]
}
```

### Plugin Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Kebab-case identifier |
| `source` | Yes | Relative path, GitHub repo, or git URL |
| `description` | No | Brief description |
| `skills` | No | Array of skill directory paths |
| `agents` | No | Array of agent file paths |
| `hooks` | No | Hook configuration path or inline |
| `mcpServers` | No | MCP server configuration |

### Source Types

**Relative Path:**
```json
"source": "./"
```

**GitHub:**
```json
"source": {
  "source": "github",
  "repo": "owner/repo",
  "ref": "v1.0.0"
}
```

**Git URL:**
```json
"source": {
  "source": "url",
  "url": "https://gitlab.com/org/repo.git",
  "ref": "main"
}
```

---

## Validation Commands

```bash
# Validate marketplace
claude plugin validate .
/plugin validate .

# Test local marketplace
/plugin marketplace add ./path/to/marketplace
/plugin install plugin-name@marketplace-name
```

---

## Reserved Names (Blocked)

- `claude-code-marketplace`
- `claude-code-plugins`
- `claude-plugins-official`
- `anthropic-marketplace`
- `anthropic-plugins`
- `agent-skills`
- `life-sciences`

---

## Permission Control

### Deny all skills:
```json
{
  "permissions": {
    "deny": ["Skill"]
  }
}
```

### Allow specific skills:
```json
{
  "permissions": {
    "allow": [
      "Skill(commit)",
      "Skill(deploy:*)"
    ]
  }
}
```

---

## Extended Features

### Extended Thinking

Include "ultrathink" anywhere in skill content to enable extended thinking mode:

```markdown
This skill uses **ultrathink** for complex reasoning.
```

### Nested Directory Discovery

Tower discovers skills through the project-visible skill registry and project-mounted skill folders. Nested legacy provider skill folders are import/fallback inputs only; do not create new Tower skills there.

### Commands Compatibility

Tower slash commands are backed by the Tower skill registry and project-visible SKILL.md packages. Legacy command folders may still be imported for compatibility, but new commands should be authored as Tower skills.

### Context Budget

By default, skill descriptions are limited to 15,000 characters total. To increase the limit, set the `SLASH_COMMAND_TOOL_CHAR_BUDGET` environment variable.

Run `/context` to check for warnings about excluded skills.

---

## References

- [Skills Documentation](https://docs.anthropic.com/en/docs/claude-code/skills)
- [Plugin Marketplaces](https://docs.anthropic.com/en/docs/claude-code/plugin-marketplaces)
- [Plugins Reference](https://docs.anthropic.com/en/docs/claude-code/plugins-reference)
