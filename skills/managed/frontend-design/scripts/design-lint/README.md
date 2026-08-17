# design-lint

Vendored deterministic detector from `pbakaus/impeccable`, used by Tower's `frontend-design` skill to catch AI-slop and basic UI quality issues after generation.

## Usage

```bash
node /workspace/.tower/skills/frontend-design/scripts/design-lint/bin/cli.js detect <target> --json
```

Targets may be a directory, an HTML file, or a URL. URL/browser mode may require optional browser dependencies; file and fast regex/static checks are the preferred Tower default.

## Rule families

- AI slop: overused fonts, purple/cyan generated palettes, gradient text, nested cards, icon-tile stacks, hero eyebrow chips, em-dash/buzzword cadence, oversized H1, crushed tracking, etc.
- Quality: low contrast, cramped padding, line length, skipped headings, tiny text, overflow, layout-property animations, etc.

Do not shell out to `npx impeccable` for routine Tower work. Use this vendored copy for reproducibility.
