---
name: plan-refine
description: |
  Refine plans using structured reading methodologies adapted to domain type.
  Use when reviewing plans, RFCs, proposals, strategies, or any structured document
  that needs rigorous analysis beyond surface-level feedback.
context: fork
agent: general-purpose
allowed-tools: Read, Glob, Grep, Write, Edit, Skill
argument-hint: "[path/to/plan.md | \"inline plan text\"] [--pass ground|stress|widen|all] [--domain ...]"
---

# Plan Refine: Structured Plan Review via Reading Methodologies

Refine plans through a principled cognitive sequence — understand before challenging, challenge before expanding, expand before synthesizing. Adapts methodology selection to domain type and plan maturity.

## Motivation

Unstructured plan review triggers sycophantic responses. This skill applies domain-adapted reading methodologies in a fixed cognitive order — classify, ground, stress, widen, synthesize — to prevent mode-blending and ensure rigorous analysis.

## Usage

```
/plan-refine path/to/plan.md                          # Full review from file
/plan-refine "We plan to migrate our monolith..."      # Inline plan text
/plan-refine path/to/plan.md --pass ground             # Grounding pass only
/plan-refine path/to/plan.md --pass stress             # Adversarial pass only
/plan-refine "plan text" --domain business             # Inline with domain override
```

---

## Protocol: ORIENT -> GROUND -> STRESS -> WIDEN -> REFINE

| Phase | Cognitive Mode | Question | Anti-Pattern Prevented |
|-------|---------------|----------|----------------------|
| ORIENT | Diagnostic | What kind of plan is this? | Applying wrong tools to wrong domain |
| GROUND | Constructive | What does this plan actually claim? | Challenging before understanding |
| STRESS | Adversarial | How will this plan fail? | Expanding scope before testing core |
| WIDEN | Expansive | Who/what is missing? | Scope creep without grounded critique |
| REFINE | Synthetic | What specific changes improve it? | Premature synthesis before full analysis |

**Principle**: understand -> verify -> challenge -> expand -> synthesize. Each phase produces a distinct artefact. Synthesis only after all analytical passes.

---

## Input Parsing

Parse `$ARGUMENTS` for:

| Argument | Format | Default |
|----------|--------|---------|
| Plan source | First positional argument | Required |
| `--pass` | `ground`, `stress`, `widen`, `all` | `all` |
| `--domain` | `software`, `business`, `research`, `education`, `policy`, `creative` | Auto-detect |

### Detecting plan source type

1. **File path**: Argument contains `/` or ends with `.md`, `.txt`, `.rst` → Read the file
2. **Inline text**: Argument is a quoted string or doesn't match file-path patterns → use directly as plan content
3. **Missing**: No positional argument provided → ask user to provide plan (paste text or file path)

After resolving plan content, read supporting files:
- [domain-adaptation.md](./domain-adaptation.md) — classification heuristics and perspective sets
- Method files from [methods/](./methods/) — loaded selectively after ORIENT (see Phase 0)

---

## Phase 0: ORIENT (Classification + Checkpoint)

Read the plan file. Classify along 3 axes:

### Domain Classification

Use signal-based heuristics from [domain-adaptation.md](./domain-adaptation.md) to detect the plan's domain. If `--domain` flag is set, use that instead.

| Domain | Key Signals |
|--------|------------|
| software | Code references, API mentions, system components, deployment, databases |
| business | Revenue, market, competitive, ROI, stakeholders, GTM |
| research | Hypothesis, methodology, variables, validity, IRB, literature |
| education | Learning objectives, assessment, pedagogy, curriculum, rubric |
| policy | Compliance, jurisdiction, enforcement, public comment, regulation |
| creative | Audience, narrative, aesthetic, medium, portfolio, tone |

If signals span domains, classify as dominant one and note the secondary.

### Maturity Assessment

| Maturity | Signals | STRESS Method |
|----------|---------|---------------|
| sketch | Bullets, fragments, many TBDs, incomplete sections | Devil's Advocate |
| draft | Structured sections, some gaps, partial detail | Pre-Mortem |
| review-ready | Polished, complete, ready for stakeholder review | HAZOP (software) or Pre-Mortem (other) |

### Scope

- **component** — Single module, feature, or focused area
- **system** — Multiple interacting components or cross-cutting concern
- **strategic** — Organization-level, multi-initiative, or long-horizon

### CHECKPOINT

Present classification to user and wait for confirmation before proceeding.

```markdown
## Plan Refinement: ORIENT

**Plan**: [filename]
**Domain**: [detected] (signals: [top 3 signals found])
**Maturity**: [detected]
**Scope**: [detected]

**Selected methodology combination**:
- GROUND: [ATDD | IRAC] — [1-line rationale]
- STRESS: [Pre-Mortem | Devil's Advocate | HAZOP] — [1-line rationale]
- WIDEN: PBR with [domain-specific perspectives]

**Proceed?** [Confirm / Override domain / Override methodologies]
```

Do not proceed until user confirms or overrides.

### Load Selected Methods

After user confirms classification, read only the selected methodology files:
- GROUND method: [methods/atdd.md](./methods/atdd.md) or [methods/irac.md](./methods/irac.md)
- STRESS method: [methods/pre-mortem.md](./methods/pre-mortem.md), [methods/devils-advocate.md](./methods/devils-advocate.md), or [methods/hazop.md](./methods/hazop.md)
- WIDEN: always [methods/pbr.md](./methods/pbr.md)

---

## Phase 1: GROUND (Constructive Verification)

> You are now in CONSTRUCTIVE mode. Your goal is to verify what this plan claims — not to criticize it, not to expand it. Ask: can each claim be verified? Is each requirement specific enough to test?

### Methodology Selection

| Domain | Method | Rationale |
|--------|--------|-----------|
| software, research | ATDD | Testability is the primary grounding concern |
| business, policy, education | IRAC | Principle-based analysis grounds better than testability |
| creative | IRAC (adapted) | Creative plans need craft-principle grounding |

### Skill Reload (when applicable)

- For IRAC on software/engineering-adjacent plans: invoke `/tech-lead` for engineering principles
- For trigger sentence quality concerns: invoke `/prompt-architect` for anti-sycophancy verification

### Execution

Use the complete trigger sentence for the detected domain from the selected GROUND method file. Do NOT paraphrase or abbreviate — the precise phrasing contains anti-sycophancy mechanisms.

### Artefact: Grounding Report

- **ATDD**: Acceptance criteria per requirement, with underspecification flags for anything untestable
- **IRAC**: Principle-verdict pairs (pass / fail / insufficient-information) per significant choice

---

## Phase 2: STRESS (Adversarial Challenge)

> You are now in ADVERSARIAL mode. Your goal is to find how this plan will fail. Do not validate, do not suggest improvements yet. Assume failure and explain why.

### Methodology Selection

| Maturity | Default | Alternative |
|----------|---------|-------------|
| sketch | Devil's Advocate | — |
| draft | Pre-Mortem | — |
| review-ready (software) | HAZOP | Pre-Mortem |
| review-ready (other) | Pre-Mortem | — |

### Execution

Use the complete trigger sentence for the detected domain and maturity from the selected STRESS method file. Do NOT paraphrase — "implemented exactly as written" prevents blame-shifting to implementation; "most likely root causes" prevents exhaustive low-probability enumeration.

### Artefact: Risk Report

- **Pre-Mortem**: Failure scenarios with root causes anchored to specific plan sections
- **Devil's Advocate**: Single strongest objection with causal argument and specific alternative
- **HAZOP**: Deviation register filtered to high-severity items only

---

## Phase 3: WIDEN (Perspective Expansion)

> You are now in EXPANSIVE mode. Your goal is to see what's missing — not to re-analyze what's already been found. Adopt each perspective fully and report what THAT person would notice that previous analysis missed.

### Always PBR

Perspectives adapt to domain. Use the domain-specific perspective triplet from [domain-adaptation.md](./domain-adaptation.md) as defaults. If the plan's stakeholders clearly differ from the defaults, generate context-specific perspectives instead.

### Execution

Use the complete PBR trigger sentence for the detected domain from [methods/pbr.md](./methods/pbr.md). Structural separation of perspectives is critical — each perspective must produce distinct findings, not a blended list.

### Artefact: Perspective Report

Distinct findings per perspective, structurally separated with clear headers.

---

## Phase 4: REFINE (Synthesis)

> You are now in SYNTHESIS mode. Cross-reference findings from GROUND, STRESS, and WIDEN. Prioritize issues found by multiple passes. Produce concrete, actionable refinements.

**Skip this phase for single-pass mode** (`--pass ground|stress|widen`).

### Synthesize into:

**1. Critical findings** (must-address)
Issues surfaced by 2+ passes, or any single finding with high severity.

**2. Improvement opportunities** (should-address)
Single-pass findings with clear remediation.

**3. Questions for the author**
Insufficient-information verdicts from GROUND, or perspective-specific unknowns from WIDEN.

**4. Suggested refinements**
For each:
- **Section reference**: Heading or line range in source plan
- **Current text**: What exists or is missing
- **Suggested change**: Specific replacement or addition
- **Rationale**: Which pass(es) surfaced this, why it matters

---

## Re-entry: Misclassification Recovery

If Phase 1 (GROUND) reveals the domain classification was wrong — e.g., what appeared to be a "software" plan is actually "business strategy with a software component" — return to ORIENT with updated classification. Re-select methodologies and flag the reclassification to the user.

---

## `--pass` Flag Behavior

| Flag | Phases Run | Output |
|------|-----------|--------|
| `all` (default) | ORIENT -> GROUND -> STRESS -> WIDEN -> REFINE | Full refinement report |
| `ground` | ORIENT -> GROUND | Grounding artefact only |
| `stress` | ORIENT -> STRESS | Risk artefact only |
| `widen` | ORIENT -> WIDEN | Perspective artefact only |

Single-pass mode skips REFINE synthesis. Useful for targeted analysis or iterative refinement.

