# Content Classification Reference

Heuristics for classifying skill sections as Expert-Critical, Reference, or Bloat.
Used by `/skill-architect distill`. See SKILL.md for the protocol overview.

---

## The Three Categories

| Category | Definition | Disposition |
|----------|-----------|-------------|
| **Expert-Critical** | Decision cues that change model behavior at ambiguous points — core protocol steps, when-to-use heuristics, recognition triggers, input parsing | Keep in SKILL.md |
| **Reference** | Useful detail not needed every invocation — extended examples, config tables, scoring rubrics, classification gyms, delegation frameworks | Extract to supporting file |
| **Bloat** | Redundant with model training, duplicates CLI `--help`, no observable impact on execution quality | Condense or remove |

---

## Skill Purpose Dimension

Orthogonal to content classification. Purpose determines *testing strategy* and *lifecycle*.

| Purpose | Definition | Testing Implication |
|---------|-----------|-------------------|
| **Capability Uplift** | Teaches a technique the model cannot reliably perform without the skill | Re-test baseline after model updates — the model may learn the technique natively |
| **Encoded Preference** | Encodes a team's workflow, conventions, or sequencing that the model cannot infer from training data | Test for fidelity to the actual workflow — value is stable across model updates |

> **Why this matters**: A capability-uplift skill that once dramatically improved output may now add complexity without benefit — the model learned the technique. An encoded-preference skill never becomes unnecessary because no model improvement teaches your team's specific process. Knowing which type you're testing tells you *when* and *what* to test.

**Heuristic**: "If the model were retrained on 10x more data, would this skill become unnecessary?" Yes → capability uplift. No → encoded preference.

**Adapt**: Many skills have both aspects. A code review skill might uplift the model's ability to spot concurrency bugs (capability) while encoding your team's review checklist (preference). Test each aspect separately — the capability part may retire while the preference part persists.

**Interaction with content categories**: Purpose is orthogonal. An Expert-Critical section in a capability-uplift skill may need reclassification to Bloat after a model update. The same section in an encoded-preference skill is stable indefinitely.

---

## Seven Classification Tests

Apply each test to every section. The dominant signal determines category.

### 1. Decision Cue Test

> "Does this section contain cues that change how the model responds to ambiguous input?"

If the section helps the model choose between two valid approaches (e.g., "use read-only
for analysis, full-auto for execution"), it contains decision cues → **Expert-Critical**.

**Example**: Codex "Configuration by Use Case" table (maps task type → model + reasoning
+ sandbox) — Expert-Critical because it drives the primary model selection decision.

### 2. Mental Simulation Test

> "If this section were absent, would the model make a materially different (worse) decision on a representative task?"

Run a quick mental simulation: imagine the model executing a typical task with this
section removed. If you can articulate a specific decision that would change → **Expert-Critical**.
If "maybe, in edge cases" → **Reference**. If no impact → **Bloat**.

**Example**: Codex "Execution Protocol" phases 1-3 — removing these would completely
change execution behavior → Expert-Critical.

### 3. Redundancy Test

> "Does the model already know this from training? Would omitting it produce the same output?"

Content that restates well-known patterns, CLI flag lists available via `--help`, or
general advice ("provide context", "be specific") is typically redundant.

**Example**: Codex "Safety Guidelines" section listing generic advice like "default to
read-only" and "never use --yolo" — the model already follows these patterns → Bloat.

### 4. Frequency Test

> "Is this content needed on every invocation, or only in specific situations?"

Sections triggered by specific flags (--panel, --json), specific modes (deep vs shallow),
or specific scenarios (debugging vs design) are situational → **Reference**.

**Example**: Codex "Expert Panels" section with 4 detailed panel definitions — only
needed when user passes `--panel` flag → Reference.

### 5. Laddering Test (CTA-derived)

> "Why is this section here?" Ask repeatedly until you reach bedrock.

If the chain bottoms out at a concrete decision the section enables ("because without it
the model picks the wrong reasoning level") → **Expert-Critical**.

If it bottoms out at "because we always include it" or "it seemed like a good idea" → **Bloat**.

**Example**: Laddering on "Comparing Models" section in Gemini skill:
- Why? "So users know they can compare."
- Why include in the skill? "Because it's related."
- Does it enable a decision? "Not really, it's a suggestion."
→ Bloat.

### 6. Input Model Fitness Test

> "Does this section assume a specific input delivery mechanism (file path, inline text, conversation context) that may not hold across all hosts?"

If the section's logic depends on a specific input mechanism (e.g., "read the file at path",
"parse the conversation history") → flag as **Expert-Critical with portability risk**. The
section is correctly Expert-Critical, but its content may need adaptation for cross-host
portability.

**Example**: plan-refine "Input Parsing" — Expert-Critical (drives argument handling), but
assumed file-path delivery which breaks on Codex/Gemini where plans are inline/in-context.

### 7. Default Rigidity Test

> "Are the defaults in this section appropriate for the breadth of expected inputs, or are they overconstrained for a specific scenario?"

If the section contains hardcoded defaults that only fit a narrow slice of expected use
cases → flag as **Expert-Critical with rigidity risk**. The section is needed every
invocation, but its specific values are too narrow.

**Example**: plan-refine "Perspective Sets" — Expert-Critical (drives WIDEN phase), but
"On-call engineer at 3AM" is overconstrained for non-software contexts. Defaults should be
starting points with override guidance, not absolute prescriptions.

---

## Tie-Breaking Rules

Expert-Critical is the conservative default:
- Demote to Reference only if **3+ tests** agree it's not Expert-Critical
- Classify as Bloat only if **4+ tests** agree
- When in doubt, keep → safer to leave content than to remove it wrongly

---

## Section Granularity

- Classify at **H2 level** by default
- Classify H3 sections **independently** only if they exceed 50 lines
- Nested H4+ sections inherit their parent H3's classification

---

## Known Patterns (This Repo)

Recurring patterns observed across skills in this repository:

| Pattern | Lines | Typical Category | Typical Destination |
|---------|-------|-----------------|---------------------|
| RPD Cards | 180-220 | Reference | `testing.md` |
| Classification Gym scenarios | 50-90 | Reference | `testing.md` |
| Scoring Rubrics (0-3 tables) | 30-60 | Reference | `testing.md` |
| Test Pack + Success Criteria | 15-30 | Reference | `testing.md` |
| STICC/CTCO framework details | 40-60 | Reference | `reference.md` |
| Expert Panel descriptions | 40-60 | Reference | `panels.md` or `reference.md` |
| CLI reference tables | 20-40 | Bloat (duplicates --help) | Condense to 5L table |
| Safety guidelines (generic) | 8-15 | Bloat (model knows) | Remove |
| "Comparing Models" sections | 10-15 | Bloat (obvious) | Remove |
| Host-Specific Execution tables | 10-15 | Expert-Critical | Keep (drives behavior) |
| Hardcoded perspective/persona tables | 10-20 | Expert-Critical (check rigidity) | Keep but verify defaults |
| Input Parsing sections | 10-20 | Expert-Critical | Keep |
| Core protocol steps | 30-80 | Expert-Critical | Keep |
| Configuration by Use Case | 10-20 | Expert-Critical | Keep (decision table) |

---

## Edge Cases

- **Skill-specific safety guidelines** (not generic "be careful" but skill-unique rules like
  "ONLY Gemini 3 series supported") → Expert-Critical, not Bloat
- **Examples section** — if examples demonstrate non-obvious invocation patterns → Expert-Critical;
  if they repeat what Usage already shows → Bloat
- **Design Rationale sections** — usually Reference (helpful for maintainers, not needed
  for execution)
- **Integration sections** ("pairs with /research") — usually Expert-Critical if they
  contain conditional logic ("if X, invoke /research"); Bloat if just a list of related skills
- **Input Parsing with host assumptions** — if the section assumes file paths, check whether
  the skill is synced to non-Claude hosts (no `sync-exclude`). Flag portability risk if so.
