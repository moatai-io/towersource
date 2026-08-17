# Design System: Tower

> **Source of truth:** the implemented theme and component patterns in `packages/frontend/src/index.css` and `packages/frontend/src/components/**`. This document guides new UI; when it conflicts with working tokens or an explicit decision record, the implementation and decision record win until this file is updated.

## 1. Visual Theme & Atmosphere

Tower is an AI command center for sustained team work, not a marketing site or a novelty chatbot. It should feel like a calm, dense, dependable workbench: enough hierarchy to orient quickly, enough restraint to keep long sessions comfortable, and enough semantic color to make state obvious without turning the screen into a dashboard of competing lights.

The visual identity combines slate-tinted surfaces with a calm teal accent. Dark mode is the default reference, but light mode is a first-class theme rather than an inverted afterthought. Content, files, sessions, tools, and status must remain readable in both themes.

**Key characteristics:**

- Workbench density with clear hierarchy, not spacious landing-page composition.
- Calm teal for selection and primary action; semantic colors only for meaning.
- Layering through adjacent surfaces and borders before shadows.
- Korean-first readability with complete English parity.
- Mobile surfaces that are touch-safe, vertically stable, and free of horizontal drift.
- UI state should be immediately legible: selected, running, waiting, failed, disabled, and destructive must not depend on color alone.

## 2. Color Palette & Roles

Never copy a dark-theme hex directly into a component. Use `surface-*`, `primary-*`, semantic `tone-*`, or the underlying CSS variables so light and dark themes remain paired.

### Primary Accent

| Role | Dark | Light | CSS token / utility |
|---|---:|---:|---|
| Primary action | `#14B8A6` | `#0D9488` | `--th-accent-500`, `primary-500` |
| Strong accent text | `#5EEAD4` | `#0F766E` | `--tone-accent-text`, `tone-accent tone-text` |
| Accent surface | `rgba(20,184,166,.12)` | `rgba(13,148,136,.10)` | `--tone-accent-bg`, `tone-accent tone-card` |
| Accent border | `rgba(45,212,191,.30)` | `rgba(15,118,110,.24)` | `--tone-accent-border` |

### Surfaces and Text

| Role | Dark | Light | CSS token / utility |
|---|---:|---:|---|
| App background | `#071012` | `#FFFFFF` | `--th-bg-primary`, `surface-950` |
| Secondary background | `#0B171A` | `#F8FBFA` | `--th-bg-secondary`, `surface-900` |
| Tertiary background | `#102023` | `#EEF6F4` | `--th-bg-tertiary`, `surface-850` |
| Raised/selected surface | `#1A3033` | `#DFEAE7` | `--th-bg-surface`, `surface-800` |
| Border | `#42656A` | `#829C98` | `--th-border`, `surface-700` |
| Primary text | `#EDF7F6` | `#111827` | `--th-text-primary`, `surface-100` |
| Secondary text | `#B2C9C8` | `#4B5563` | `--th-text-secondary`, `surface-200/300` |
| Muted text | `#86A3A2` | `#6B7280` | `--th-text-muted`, `surface-500/600` |

### Semantic Tones

Use a semantic tone pair, not raw color utilities, for reusable status UI.

| Meaning | Utility | Typical use |
|---|---|---|
| Success / completed | `tone-success` | successful run, saved state, completed step |
| Warning / waiting | `tone-warning` | attention needed, pending decision, external change |
| Danger / destructive | `tone-danger` | failed run, deletion, irreversible action |
| Information | `tone-info` | neutral system information |
| Accent / selected | `tone-accent` | primary action, selected tab, current step |
| Muted / inactive | `tone-muted` | disabled, unavailable, low-priority metadata |

Apply the semantic role with a shape utility: `tone-pill`, `tone-card`, or `tone-action`. Add `tone-text`, `tone-bg-soft`, or `tone-border` only when composing a custom shape.

## 3. Typography Rules

### Font Family

- **UI and prose:** `Pretendard Variable`, bundled locally; fallback stack is defined by `--font-sans`.
- **Code and identifiers:** `JetBrains Mono` first, then platform monospace fallbacks via `--font-mono`.
- Do not introduce a new webfont for an isolated screen.
- Code disables ligatures and custom letter spacing to preserve terminal and ASCII alignment.

### Hierarchy

| Role | Font | Size | Weight | Line height | Tracking | Notes |
|---|---|---:|---:|---:|---:|---|
| App/page title | Sans | 18–24px | 700–850 | 1.15–1.3 | tight/default | Reserve for the primary screen heading |
| Section heading | Sans | 16–18px | 650–750 | 1.3 | default | One clear heading per region |
| Body / chat | Sans | 16px default | 400–500 | 1.4–1.6 | default | Respect user font-size preference |
| Compact UI label | Sans | 13–14px | 500–650 | 1.3–1.45 | default | Buttons, controls, table cells |
| Metadata | Sans | 11–13px | 400–600 | 1.2–1.4 | default | Never use low contrast to compensate for size |
| Code | Mono | 13–14px default | 400–500 | 1.55–1.65 | `0` | Horizontal scroll rather than destructive wrapping |

Use the existing preference-aware classes and variables for chat, prose, inputs, tables, sidebar rows, and tool blocks. Do not hard-code a size when `text-msg-size`, `text-input-size`, `text-ui-table-size`, or the corresponding variable already owns it.

## 4. Component Styles

### Buttons

- Primary/select actions use `tone-accent tone-action`; destructive actions use `tone-danger tone-action`.
- Secondary buttons use a surface border, transparent/subtle background, and readable `surface-200/300` text.
- Icon-only buttons need an accessible label and a minimum practical touch target.
- Disabled state must change both interaction and appearance; do not rely on reduced opacity alone when meaning could be ambiguous.
- Use 160ms color transitions. Avoid springy scaling, glow pulses, or decorative motion on routine controls.

### Cards and Containers

- Prefer one structural container per conceptual region. Use `surface-900/950` with `surface-700/800` borders.
- Typical radius is `rounded-lg`, `rounded-xl`, or `rounded-2xl`; reserve pill radius for tags/status and full circles for avatars/icons.
- Shadows are supporting hierarchy, not decoration: use `shadow-sm/xl/2xl` only for overlays, floating inspectors, and modals.
- Avoid nested card stacks. Within a card, establish hierarchy with headings, dividers, spacing, and subtle surface changes.

### Inputs

- Inputs use inherited Pretendard, a `surface-950/800` background, `surface-700` border, and visible focus border/ring in primary teal.
- Keep entered text larger than placeholder text where the adaptive input variables specify it.
- Validation text must be adjacent to the field and use semantic tone plus plain-language guidance.
- Secret inputs must never display stored values; explain Vault behavior in supporting copy.

### Navigation and Selection

- Selected tabs, pills, and rows must pair background **and** text colors that remain legible in both themes.
- Use the established `tone-accent tone-action` pattern or a verified light/dark pair.
- Do not use `text-white` or pale `primary-200/300` as a universal selected-state foreground.
- Headers and tab bars should remain visually stable: translated collections and measured data must not trigger render/layout loops.

### Status and Feedback

- Status is expressed through semantic tone, a concise label, and where useful an icon or shape.
- Toasts are for transient outcomes; inline cards are for states the user must inspect or act on.
- Preserve server error detail when available, but localize product-owned fallback language.

### Dynamic Content

Charts, Mermaid, tables, timelines, forms, terminal output, and other chat blocks inherit Tower surfaces and typography. Prefer calm, semantic palettes; never introduce a rainbow palette by default. Parsing failure must fall back to readable source content rather than a blank region.

## 5. Layout & Spacing

### App Shell

- Tower is a full-height application with scrolling owned by internal panes, not `body`.
- Keep headers, tab bars, sidebars, viewers, and chat input as stable regions. Avoid layout shifts when status or translated copy changes.
- Dense work areas use 8–16px internal spacing; primary panels and modal sections generally use 16–28px.

### Spacing Scale

Use Tailwind’s 4px-based scale deliberately:

| Purpose | Preferred values |
|---|---|
| Tight icon/text gap | 4–6px (`gap-1` to `gap-1.5`) |
| Control and row gap | 8–12px (`gap-2` to `gap-3`) |
| Panel padding | 12–20px (`p-3` to `p-5`) |
| Major section separation | 20–32px (`gap-5` to `gap-8`) |

Do not add padding layers merely because every child is a card. Align content edges across headings, lists, empty states, and actions.

### Content Width

- Workbench panes may fill available width.
- Reading surfaces should constrain line length where practical; code, tables, CAD, and graphs may use the full pane.
- Long paths and identifiers use truncation or explicit wrapping without forcing the app wider than the viewport.

## 6. Elevation & Shadows

Tower primarily uses surface contrast and borders. Elevation levels:

1. **Base:** `surface-950`; no shadow.
2. **Pane/card:** `surface-900/800` plus a subtle border; usually no shadow or `shadow-sm`.
3. **Floating control/inspector:** opaque or near-opaque surface, border, `shadow-xl`.
4. **Modal/critical overlay:** backdrop plus bordered `surface-900`, `shadow-2xl`.

The branded app background may use the implemented low-opacity teal/blue radial gradients. Do not apply gradient backgrounds to ordinary cards, headings, buttons, or text. Avoid cyan glow as a generic sign of “AI.”

## 7. Responsive Behavior

- Core breakpoints in existing UI are 640px (`sm`), 768px (`md`/mobile lock), and 900px for the login layout.
- On mobile, prioritize one task surface at a time; side panels become overlays or full-screen panes rather than squeezed columns.
- Interactive targets should generally be at least 44px high (`min-h-11`) for primary touch actions.
- The root locks horizontal movement with `touch-action: pan-y`; only content that genuinely requires it (code and tables) may allow horizontal pan.
- Prevent overflow from URLs, paths, inline code, translated labels, and long Korean phrases. Test both Korean and English.
- Use `100dvh` patterns with safe fallbacks where viewport chrome affects height.
- Respect `prefers-reduced-motion`; critical state must not depend on animation.
- Verify selected states, overlays, keyboard focus, and scroll ownership in both themes at mobile and desktop widths.

## 8. Do's and Don'ts

### Do

- Use `surface-*`, `primary-*`, and `tone-*` tokens before raw Tailwind colors.
- Treat light and dark foreground/background colors as a tested pair.
- Reuse established deep component patterns and keep new UI consistent with neighboring workbench surfaces.
- Keep hierarchy clear through typography, spacing, borders, and meaningful state labels.
- Localize all user-facing strings and verify Korean/English parity.
- Use real icons from the existing SVG/icon vocabulary; add accessible labels to icon-only controls.
- Test loading, empty, error, selected, disabled, long-content, and mobile states.
- Prefer subtle, stable transitions and honor reduced-motion settings.

### Don't

- Do not create a generic AI SaaS look: no purple-blue gradient hero, cyan glow everywhere, gradient text, or frosted-glass card grid.
- Do not use card monoculture or nest cards to manufacture hierarchy.
- Do not introduce beige editorial styling, oversized italic serif headings, numbered marketing sections, or repeated eyebrow chips.
- Do not use decorative icon tiles above every heading.
- Do not use raw light-colored text on light theme surfaces; verify contrast instead of assuming a dark-mode class works everywhere.
- Do not use tiny low-contrast metadata, cramped controls, skipped heading levels, or clipped translated text.
- Do not animate layout dimensions or create effects whose dependencies change on every render.
- Do not use filler copy such as “streamline,” “empower,” “supercharge,” or repeated “Not X. Just Y.” constructions.
- Do not invent a new visual language for a single feature. Extend tokens and document the reason when the existing system is insufficient.

## 9. Agent Prompt Guide

When building or modifying Tower UI:

1. Read this file, `AGENTS.md`, the nearest component/module README, and `packages/frontend/src/index.css` token definitions relevant to the work.
2. Identify the user’s task, the persistent state, and the mobile behavior before choosing visual structure.
3. Reuse neighboring layout and component patterns. Prefer direct, explicit code over a new abstraction for one screen.
4. Build with semantic theme tokens. A selected or status state must pair foreground, background, and border for light and dark themes.
5. Use Pretendard for UI/prose and the existing monospace stack for code and identifiers.
6. Keep user-facing copy in locale files. Validate Korean and English, including arrays returned with `returnObjects: true`; stabilize collection references before using them in effect dependencies.
7. Ensure icon-only controls have accessible names, important touch controls are about 44px high, and keyboard focus remains visible.
8. Test normal, loading, empty, error, selected, disabled, overflow, and reduced-motion states at desktop and mobile widths.
9. Remove AI-slop before handoff: gratuitous gradients/glow, nested cards, decorative badges, verbose marketing copy, arbitrary colors, and unnecessary motion.
10. If a new token or exception is necessary, add it to the theme layer rather than scattering raw values, and update this document or the relevant decision record.

**Implementation check:** a UI change is not complete until it is readable in light and dark themes, stable on mobile, accessible by keyboard/screen reader where applicable, and consistent in Korean and English.
