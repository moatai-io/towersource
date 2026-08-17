---
name: svg
description: |
  SVG infographic generator — polished dark-themed illustrations. Static by default,
  with an optional animation layer when motion carries meaning.
  Use when: "SVG 만들어", "infographic", "인포그래픽", "이쁘게 그려", "diagram",
  "SVG 일러스트", "hero image", "README diagram", "concept visualization", "/svg"
  Prefer over Mermaid when: ≤5 key elements, strong visual identity matters,
  hero/onboarding/README/branding context, before-after or metaphor-driven.
  Prefer Mermaid when: 6+ nodes, standard structural diagrams (ERD, class, sequence,
  state machines), auto-layout desired, frequently edited by the team.
  NOT for charts/data viz → use chart codeblock.
argument-hint: "[concept or topic to illustrate] [--animated]"
---

# svg — Static-first SVG Infographic Generator

> **Default: static, editorial, polished.** Animation is an optional layer — add it
> only when movement carries meaning (data flow, transitions, emphasis).
> Pure SVG. No JavaScript, no CSS keyframes. Works in GitHub README, PDFs, slides,
> dark terminals — anywhere.

---

## Decision: SVG vs Mermaid — by **context**, not by feature

Choose by **what the user is doing right now**, not by "what could work":

```
┌──────────────────────────────────────────────────────────────────────────┐
│  CONTEXT                                           →  FORMAT             │
├──────────────────────────────────────────────────────────────────────────┤
│  Explaining a complex concept (teaching moment)    →  SVG animated       │
│    · onboarding, first-time explanation, demo      │                     │
│    · movement carries the meaning                   │                     │
│                                                                          │
│  Writing docs / README / wiki / in-chat reference  →  SVG static         │
│    · re-read content, embedded in markdown          │                     │
│    · PDF / print / thumbnail destination            │                     │
│                                                                          │
│  Design / structural diagrams                       →  Mermaid            │
│    · architecture, ERD, sequence, class, state      │                     │
│    · auto-layout desired, frequently edited         │                     │
│    · 6+ nodes with real relationships               │                     │
│                                                                          │
│  Numeric data (bars/lines/pies/radars)              →  chart block        │
└──────────────────────────────────────────────────────────────────────────┘
```

**Use this same rule when SUGGESTING a visualization proactively**, not only
when asked to generate. Before offering "here's a diagram", pick the context
first, then the format. Do not default to animated SVG because it looks cool —
defaulting to animation inside a doc is pollution.

If the answer is Mermaid, **stop and tell the user** — do not produce a bloated
hand-laid-out SVG for what should be 4 lines of mermaid.

### Quick tie-breakers

- "설명해줘" / "이해가 안 가" / "어떻게 동작해?" → likely **SVG animated** (teaching)
- "문서에 넣을 거야" / "README" / "docs" / "정리해줘" → **SVG static** or **Mermaid**
- "설계" / "구조" / "아키텍처" / "관계" → **Mermaid** first, SVG static if ≤5 nodes
- "차트" / "수치 비교" / "추세" → **chart block**

---

## REQUIRED — Output Mode (read this first)

Where does the SVG go? Decide BEFORE generating — the answer changes step 7/8.

```
┌──────────────────────────────────────────────────────────────────────┐
│  CONTEXT                                   →  OUTPUT                 │
├──────────────────────────────────────────────────────────────────────┤
│  Chat reply (default — 거의 모든 요청)     →  inline ```svg fence    │
│    · user said "보여줘", "만들어줘", "띄워줘"                        │
│    · no explicit file path given                                     │
│    · Tower renders via sanitized SVG block (near-zero overhead)      │
│                                                                      │
│  File (explicit)                            →  save to path          │
│    · user said "파일로", "저장해", "다운로드", "to {path}.svg"       │
│    · going into README, docs repo, slide deck                        │
│    · self-check via `convert → PNG → Read tool`                      │
│                                                                      │
│  Both (rare — only if user asks)            →  fence + file          │
└──────────────────────────────────────────────────────────────────────┘
```

**Inline fence format — this is what makes it render in Tower chat:**

    ```svg
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" ...>
      ...
    </svg>
    ```

Raw `<svg>` XML without the triple-backtick `svg` fence renders as escaped
text, not as a visual. This is the #1 failure mode — always wrap.

If unsure, choose inline. The user can always say "파일로 저장해" afterward
and you regenerate to a file. The opposite (file-first, then "띄워줘") wastes
a round trip.

---

## REQUIRED — Source-of-Truth Comment

Every generated SVG MUST begin with a comment block that records what it is and
how to regenerate it. This is the single biggest maintenance lever: when the
underlying concept changes, **regenerate** instead of hand-patching coordinates.

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600">
  <!--
    svg-skill: v2 (static-first)
    generated: YYYY-MM-DD
    variant: static                    # or "animated"
    concept: |
      One-line description of what this diagram shows.
    source-mermaid: |
      flowchart LR
        A --> B --> C
    prompt: "original user request, verbatim or paraphrased"
    notes: |
      - any design decisions worth remembering
      - palette choices, layout quirks
  -->
  ...
</svg>
```

The comment is the contract. Any future regeneration starts from here.

---

## REQUIRED — Visual Self-Check

After generating, **render the SVG to an image and look at it**. You cannot
trust coordinate math blindly — you must see what you made.

### Procedure

1. Save SVG to the requested target path. If no path is given, follow the current project `AGENTS.md`/scaffold: draft assets under `work/<asset>/`, shareable assets under `final/<asset>/`.
2. Render to PNG using ImageMagick (installed system-wide):
   ```bash
   convert -density 200 -background none <file>.svg <same-folder>/svg-check.png
   ```
   Fallbacks if convert is unavailable:
   ```bash
   rsvg-convert -w 1600 -h 1200 <file>.svg -o <same-folder>/svg-check.png
   # or headless chromium screenshot via puppeteer (~/node_modules/puppeteer)
   ```
3. **Read the PNG back** using the Read tool and visually inspect it
4. Run the Visual Review Checklist (below). If anything fails → fix and re-render.
5. Only then declare done.

### Visual Review Checklist

- [ ] No text cut off at viewBox edges
- [ ] No text overlaps other text, lines, or glow halos
- [ ] Connector lines terminate **at** node edges (not inside, not floating past)
- [ ] Colors have sufficient contrast on the transparent/dark background
- [ ] Glow filters land where intended — no bleeding onto labels
- [ ] Cards/elements in a row share a baseline (top and bottom aligned)
- [ ] Title and subtitle are present, readable, not clipped
- [ ] No off-by-one in coordinate math (things visibly lined up)
- [ ] If **animated**: entrance sequence makes narrative sense (anchor element first)
- [ ] Comment block at top contains variant, concept, source-mermaid, prompt

If any item fails → fix and re-render. Do not ship on first try.

> **Why this step matters.** Coordinate-driven vector graphics are exactly the
> kind of output that *looks right in the code* and *is wrong on the screen*.
> The render step catches issues the code review cannot.

---

## Design System

### Canvas
- **ViewBox**: `0 0 800 600` (landscape 4:3) for standard concepts.
  Use `0 0 800 300` for banners, `0 0 600 600` for square hero.
- **Background**: TRANSPARENT — no background `<rect>`. Designed for dark hosts.
- **Font**: `Inter, system-ui, sans-serif` (headings/body), `JetBrains Mono` for code.

Font import in `<defs><style>`:
```xml
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&amp;display=swap');
  text { font-family: 'Inter', system-ui, sans-serif; }
  .mono { font-family: 'JetBrains Mono', monospace; }
</style>
```

### Color Palette

| Role | Color | Hex | Light variant | Usage |
|------|-------|-----|---------------|-------|
| Primary | Indigo | `#6366F1` | `#A5B4FC` | Main elements, decorative lines |
| Secondary | Purple | `#8B5CF6` | `#C4B5FD` | Accents, agents, glow |
| Success | Emerald | `#10B981` | `#6EE7B7` | Positive, skills |
| Warning | Amber | `#F59E0B` | `#FCD34D` | Attention, prompts |
| Danger | Red | `#EF4444` | `#FCA5A5` | Problems, errors |
| Cyan | Cyan | `#06B6D4` | `#67E8F9` | Info, alt accent |
| Text | Light | `#E0E0E0` | — | Primary text |
| Text Muted | Gray | `#9CA3AF` | — | Subtitles, labels |
| Card BG | Dark Slate | `#0F172A` | — | Card/node fills |
| Card BG Alt | Dark Purple | `#1E1B2E` | — | Chat bubbles, alt panels |
| Surface | Slate | `#1E293B` | — | Directory labels, badges |
| Border | Gray | `#4B5563` / `#374151` | — | Connector lines |

### Glow Filters

Define one per color used in `<defs>`:

```xml
<filter id="glow-{name}" x="-40%" y="-40%" width="180%" height="180%">
  <feGaussianBlur stdDeviation="4" result="blur"/>
  <feFlood flood-color="{hex}" flood-opacity="0.25"/>
  <feComposite in2="blur" operator="in"/>
  <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
</filter>
```

- `stdDeviation`: 3–5 subtle, higher = more diffuse
- `flood-opacity`: 0.2–0.4 subtle, 0.5+ strong emphasis
- Apply: `filter="url(#glow-{name})"`

---

## Static Mode (DEFAULT)

No `<animate>` tags. Elements render fully visible on load. The beauty comes from:

1. **Typography hierarchy** — Inter 700 for labels, JetBrains Mono for codes/ports
2. **Glow depth** — filters add dimension without motion
3. **Semantic color coding** — each role has a consistent color across the piece
4. **Element patterns** — cards, pills, chat bubbles, file icons (see below)
5. **Connector discipline** — lines terminate at node edges, dots for waypoints
6. **Alignment grids** — visual rhythm beats micro-decoration

Static mode is the default because:
- README, docs, PDF, print, thumbnails all need static
- Animation is visual noise when the content is re-read
- File size 50–70% smaller
- Easier to screenshot, embed, export

---

## Animation Layer (OPTIONAL)

Add animation ONLY when the user asks for it, or when the content IS a flow/
transition story that benefits from motion.

Set `variant: animated` in the source comment.

### Phase 1: Entrance (0s–7s)
Elements fade in sequentially, telling a story.

```xml
<g opacity="0">
  <animate attributeName="opacity" from="0" to="1"
    begin="1.5s" dur="0.4s-0.8s" fill="freeze"
    calcMode="spline" keySplines="0 0 0.2 1" keyTimes="0;1"/>
  <!-- element -->
</g>
```

- Spacing 0.3s–0.5s between groups
- Optional: stroke draw-in via `stroke-dasharray`/`stroke-dashoffset`

### Phase 2: Action (3s–8s)
Key transitions — connections appearing, warnings popping, state changes.

```xml
<circle cx="300" cy="300" r="0" fill="none" stroke="#F59E0B" stroke-width="1" opacity="0">
  <animate attributeName="r" values="0;30;40" dur="0.8s" begin="3s" fill="freeze"/>
  <animate attributeName="opacity" values="0;0.6;0" dur="0.8s" begin="3s" fill="freeze"/>
</circle>
```

### Phase 3: Passive Loop (10s+)
Subtle movement keeps the SVG alive.

```xml
<animateTransform attributeName="transform" type="translate"
  values="0,0;0,-2;0,0" dur="3.5s" begin="10s" repeatCount="indefinite"/>
<animate attributeName="stroke-opacity" values="1;0.5;1"
  dur="3s" begin="10s" repeatCount="indefinite"/>
```

- Vary `dur` slightly (3.4s, 3.8s, 4.2s) — avoid mechanical sync
- Vary `begin` slightly (10s, 10.3s, 10.6s) — organic feel

### Rule: fill="freeze" on all entrance animations
So the final frame stays visible — critical for the visual self-check
(which captures a single frame) and for users who load the SVG after `begin` times.

---

## Element Patterns

### Rounded Card/Node
```xml
<rect x="X" y="Y" width="W" height="H" rx="8"
  fill="#0F172A" stroke="{color}" stroke-width="2"/>
<rect x="X" y="Y" width="W" height="H" rx="8"
  fill="{color}" opacity="0.1"/>
<text x="CX" y="CY" text-anchor="middle"
  font-size="13" font-weight="700" fill="{light-variant}">Label</text>
```

### Pill Badge
```xml
<rect x="X" y="Y" width="W" height="28" rx="14"
  fill="#0F172A" stroke="{color}" stroke-width="1.2" filter="url(#glow-{name})"/>
<text x="CX" y="CY" font-size="12" font-weight="600"
  fill="{color}" text-anchor="middle">label</text>
```

### Person Icon (head + shoulders)
```xml
<circle cx="CX" cy="CY-25" r="14" fill="none" stroke="{color}" stroke-width="1.5"/>
<circle cx="CX" cy="CY-31" r="5" fill="none" stroke="{color}" stroke-width="1.2"/>
<path d="M{CX-11},{CY-16} Q{CX-11},{CY-23} {CX},{CY-23} Q{CX+11},{CY-23} {CX+11},{CY-16}"
  fill="none" stroke="{color}" stroke-width="1.2"/>
<text x="CX" y="CY+6" font-size="14" font-weight="700" fill="#E0E0E0" text-anchor="middle">Label</text>
```

### File Icon (tilted)
```xml
<g transform="translate(X, Y) rotate(angle)">
  <rect x="0" y="0" width="55" height="38" rx="3"
    fill="#0F172A" stroke="{color}" stroke-width="1.2"/>
  <path d="M38,0 L38,10 L48,10" fill="none"
    stroke="{color}" stroke-width="0.8" opacity="0.5"/>
  <text x="27" y="24" text-anchor="middle" class="mono"
    font-size="8" fill="{light-variant}">filename</text>
</g>
```

### Warning Badge
```xml
<g filter="url(#glow-red)">
  <rect x="X" y="Y" width="W" height="16" rx="3"
    fill="#7F1D1D" stroke="#EF4444" stroke-width="0.8"/>
  <text x="CX" y="CY" text-anchor="middle"
    font-size="8" font-weight="700" fill="#FCA5A5">warning!</text>
</g>
```

### Chat Bubble
```xml
<rect x="X" y="Y" width="W" height="38" rx="10"
  fill="#1E1B2E" stroke="#8B5CF6" stroke-width="1" stroke-opacity="0.6"/>
<polygon points="X+15,Y X+25,Y X+13,Y-12"
  fill="#1E1B2E" stroke="#8B5CF6" stroke-width="1" stroke-opacity="0.6"/>
<line x1="X+14" y1="Y" x2="X+26" y2="Y" stroke="#1E1B2E" stroke-width="2"/>
<text x="CX" y="CY" font-size="13" font-weight="600"
  fill="#E0E0E0" text-anchor="middle">"Message text"</text>
```

### Connection Line (neutral)
```xml
<line x1="X1" y1="Y1" x2="X2" y2="Y2"
  stroke="#4B5563" stroke-width="1" opacity="0.5"/>
<circle cx="MX" cy="MY" r="3" fill="{accent}"/>  <!-- optional waypoint -->
```

### Blocked Connection (dashed + red X)
```xml
<line x1="X1" y1="Y1" x2="X2" y2="Y2"
  stroke="#EF4444" stroke-width="1.5" stroke-dasharray="6 4" stroke-opacity="0.5"/>
<g filter="url(#glow-red)">
  <circle cx="MX" cy="MY" r="12" fill="#1E1015" stroke="#EF4444" stroke-width="1.5"/>
  <line x1="MX-6" y1="MY-6" x2="MX+6" y2="MY+6" stroke="#EF4444" stroke-width="2"/>
  <line x1="MX+6" y1="MY-6" x2="MX-6" y2="MY+6" stroke="#EF4444" stroke-width="2"/>
</g>
```

### Directory/Path Label
```xml
<rect x="X" y="Y" width="W" height="18" rx="3"
  fill="#1E293B" stroke="#374151" stroke-width="0.8"/>
<text x="CX" y="CY" text-anchor="middle" class="mono"
  font-size="8" fill="#9CA3AF">/workspace/.tower/skills/</text>
```

---

## Generation Process

### Step 1: Format Check
Is this actually an SVG job, or should it be Mermaid / chart? If Mermaid,
tell the user and stop.

### Step 2: Read References
Read at least 2 files from `references/` to calibrate quality. References are
historically animated, but study the **static composition** — the animation
patterns are documented in this SKILL.md.

### Step 3: Decide Variant
- **Static** (default) — README, docs, PDF, hero, thumbnail, re-read content
- **Animated** — landing, onboarding, flow demo, impact moment, user asked

### Step 4: Understand the Concept
- Core message in one sentence
- Visual metaphor (scatter/lock/flow/before-after/hierarchy/cycle)
- 3–5 key elements max

### Step 5: Storyboard (static OR animation)
- **Static**: sketch layout, assign colors by semantic role, pick the focal point
- **Animated**: anchor (0–1s) → supporting (1–5s) → action (3–7s) → title (8–10s) → passive (10s+)

### Step 6: Generate SVG
- Start with source-of-truth comment
- `<defs>` — font import + glow filters
- NO background rectangle (transparent)
- Build groups
- Title/subtitle near end (animated) or in designated area (static)

### Step 7: Self-Check (mode-dependent)
- **Inline mode (chat default)**: no PNG render step. Re-read the SVG source
  yourself, walk the Code Quality Checklist (below), then ship. The Tower
  renderer will display it — if it breaks, you'll see it in the next turn.
- **File mode**: run the full Visual Self-Check procedure
  (`convert → PNG → Read tool`). Fix, re-render, ship only when clean.

### Step 8: Deliver (mode-dependent)
- **Inline mode (chat default)** — wrap the SVG in a ```svg fenced block so
  Tower renders it. Do NOT paste raw `<svg>` XML outside a fence; it will
  render as escaped text.
- **File mode** — save to the requested path. If no path is given, follow the current project `AGENTS.md`/scaffold: draft assets under `work/<asset>/`, shareable assets under `final/<asset>/`. Then tell the user the path.
- **Both** (only if the user asked) — inline fence first, then save.

---

## Visual Metaphor Catalog

| Concept | Metaphor | Key Elements |
|---------|----------|-------------|
| Central registry | Lock → unlock → branches | Card, lock icon, category nodes |
| Problem/chaos | Scattered items + warnings | Figure, scattered files, red badges |
| Team silos | Separated columns + blocked lines | Person icons, skill pills, red X |
| Pipeline/flow | Left-to-right chain | Nodes, connector lines, waypoint dots |
| Before/After | Split layout | Left (messy) → right (clean) |
| Hierarchy | Tree structure | Root branching to children |
| Cycle | Circular flow | Nodes in ring with arrows |
| Growth | Bottom-up layers | Stack building sequentially |
| Architecture | Layered cards | Frontend / Backend / Services stack |

---

## Quality Checklist (Code)

- [ ] Source-of-truth comment present with variant, concept, source-mermaid, prompt
- [ ] ViewBox is standard (`0 0 800 600` or documented variant)
- [ ] Background is **transparent** (no background rect)
- [ ] Font import in `<defs><style>`
- [ ] Text uses Inter / JetBrains Mono
- [ ] Colors from palette only
- [ ] At least one glow filter defined and used
- [ ] If animated: `fill="freeze"` on entrance; passive loop at ~10s; varied `dur`
- [ ] If static: zero `<animate>` / `<animateTransform>` tags
- [ ] Title appears somewhere (not missing)

## Quality Checklist (Visual — after render)

- [ ] Rendered PNG reviewed via Read tool
- [ ] No clipped text
- [ ] No overlapping elements
- [ ] Connectors terminate cleanly
- [ ] Alignment looks intentional
- [ ] Colors read well on dark bg
- [ ] If animated: final frame (with `freeze`) tells the story standalone

---

## Performance Budget (chat inline)

Inline SVGs render through Tower's sanitized ```svg block (DOMPurify + SVG
profile — near-zero overhead, much cheaper than `html-sandbox`). Still, respect
the budget so a long chat stays smooth:

| Resource | Soft limit | Hard limit | Why |
|----------|-----------|-----------|-----|
| `<filter>` (feGaussianBlur) uses | 3 per SVG | 6 | GPU rasterize cost per filter; piles up fast |
| Elements with `repeatCount="indefinite"` | 5 | 10 | continuous repaint = battery / jank |
| Total element count | 60 | 120 | layout+paint cost |
| SVGs per chat message | 1 | 2 | DOM weight on a long scroll |
| Google Fonts @import | 1 (cached) | 1 | network + FOUT |

**Sanitizer note**: `<script>`, `<foreignObject>`, and `on*` handlers are
stripped by DOMPurify. SMIL `<animate>` / `<set>` is allowed but URL-bearing
`attributeName` values are neutralized. If motion is the whole point of the
visual, consider `html-sandbox` instead — it plays CSS/JS reliably and has no
sanitizer quirks (at the cost of iframe overhead).

If the concept requires more, split into two messages or move to a file in
`published/sites/` and link.

### Static-mode savings
Static SVG removes all `<animate>` tags → zero continuous repaint → ~40-60%
lower CPU during scroll, and PNG export becomes possible via
`convert -density 200 -background none file.svg out.png`.

### "Indefinite" anti-pattern
Long `repeatCount="indefinite"` loops feel great in isolation, but in a doc
with 3 SVGs they compound into visual noise. Prefer:
- `repeatCount="3"` then freeze
- Or no passive loop at all (static mode)
- Reserve indefinite for 1 "hero" element per SVG

---

## Sharing the Source Back

When returning the SVG to the user (chat or file), if the user will embed it in
docs or HTML, **also return the source-mermaid fragment** from the comment so
they have both. Mermaid for docs, SVG for the polished render — two copies,
one truth.
