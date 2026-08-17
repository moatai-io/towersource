# Skill Testing Guide

TDD-style effectiveness testing for Tower skills using Gary Klein's Naturalistic Decision Making (NDM) methodology.

## Philosophy

**LLM-first testing**: Semantic quality is measured by LLM evaluation, not deterministic code tests. The "evidence ledger" substitutes for unit tests.

**One change per iteration**: Borrowed from generative sequencer's "coin flip" principle—make one change, validate, repeat.

**Expert-novice delta**: The goal is to close the gap between expert and novice behavior. A skill succeeds when it helps Claude exhibit expert-level pattern recognition and decision-making.

---

## Theoretical Foundation: Gary Klein's NDM

This testing methodology draws from **Gary Klein's** research on how experts actually make decisions under pressure. Key works:
- *Sources of Power* (1998) — How experts use pattern recognition, not analysis
- *The Power of Intuition* (2003) — Training intuitive decision-making
- *Seeing What Others Don't* (2013) — How insights emerge from anomalies

**Core insight**: Experts don't compare options analytically. They recognize patterns, generate a first workable response, mentally simulate it, and modify only if the simulation fails.

---

## Core Concepts

### Critical Decision Method (CDM)

Gary Klein's **Critical Decision Method** is an interview technique for surfacing how experts make tough calls. Every skill has a **critical decision**—the key judgment call that separates expert from novice performance.

**CDM identifies:**
- What decision the skill helps Claude make
- What cues experts notice that novices miss
- What makes this decision difficult

**Example:**
> **Skill**: codex
> **Critical Decision**: "What reasoning level should I use for this task?"
> **Why it's critical**: Novices default to extremes (always xhigh or always medium). Experts match level to task complexity.

### Recognition-Primed Decision (RPD) Model

Klein's **RPD model** describes how experts actually decide:
1. **Recognize patterns** → "What case is this?"
2. **Generate first script** → "What do experts try first?"
3. **Mental simulation** → "Will it work here?"
4. **Modify if needed** → "What would make me change approach?"

Skills should externalize this cognitive work, not just list options.

### Job-to-Be-Done (JTBD)

A JTBD is the test case anchor. It must be:
- **Concrete**: Specific task with observable outcome
- **Context-bounded**: Specifies scenario (user expertise, tools, constraints)
- **Measurable**: Clear success/failure criteria

**Template:**
```
Task: [What the user wants to accomplish]
Context: [Fresh session, no skill, default model]
User Profile: [Expertise level, domain familiarity]
Expected Outcome: [What "good enough" looks like]
Failure Indicators: [What makes result "unsatisfying"]
```

### Prompt Quality

> **Why phrasing matters**: Success-priming ("does the skill correctly handle...") biases the evaluator toward confirming expectations. The model reads "correctly" as a signal to produce positive assessment rather than neutral observation.

**Do**: Use concrete scenarios with specific constraints ("Migrate a 500-line React class component to hooks, preserving 12 existing tests").
**Don't**: Use abstract framing ("Test if the skill works well") or success-priming ("Show how the skill improves this task").
**Adapt**: Narrower framing is fine when testing a specific claim ("Does the skill detect the off-by-one error in this function?") — the anti-sycophancy concern applies to open-ended evaluation, not targeted assertions.

### Test Pack Structure

A single JTBD can overfit. Use a minimal test pack:

| Type | Purpose | When to Add |
|------|---------|-------------|
| Primary | Core value proposition | Always |
| Edge/Adversarial | Boundary conditions | Complex skills |
| Regression | Previously fixed failure | After bug fixes |

---

## CDM Testing Framework

The following tools operationalize Gary Klein's methods for skill testing.

### Decision Requirement Table (DRT)

From Klein's cognitive task analysis work. Maps cues to expert recognition vs novice misses. **Not just "what experts notice" but "how cues change the next move."**

**DRT Template:**

| Cue Type | Expert Recognition | Novice Miss |
|----------|-------------------|-------------|
| [Cue category] | [What experts notice → what they do] | [What novices miss or misinterpret] |

**Example (codex):**

| Cue Type | Expert Recognition | Novice Miss |
|----------|-------------------|-------------|
| **Task complexity** | Reads task signals (lookup vs analysis vs novel) | Uses same level for all tasks |
| **Latency tolerance** | Trades reasoning for speed on simple tasks | Always uses max reasoning "to be safe" |
| **Model selection** | Uses gpt-5.2 for analysis, gpt-5.2-codex for coding | Uses same model regardless of task type |

### RPD Card

Based on Klein's Recognition-Primed Decision model. Externalizes the cognitive work experts do. **Mandatory when**: novelty detected, ambiguity present, high stakes, repeated failure, or cue conflict.

**RPD Card Template:**

```markdown
## RPD Card: [Critical Decision]

### Pattern Recognition
**Patterns**: [List recognizable patterns with labels]
**Dominant cues** (top 2-3): [What to look for]
**Expectancies**: If this is [pattern], I should see [X]. Surprising would be [Y].

### First Script
**First workable option**: [What experts try first]
**Quick simulate**: Will it work here? What could break it?

### Replan Triggers
**Switch when**: [Signals that mean "change approach now"]
**If it breaks, then**: [Modification or alternative script]

### Confounders
**False friends**: [Cues that look diagnostic but aren't]
**Boundary cases**: [Looks like X but is actually Y]
```

### Classification Gym

Lists don't train recognition; discriminations do. Include 3-6 micro-scenarios per skill that force pattern classification.

**Classification Gym Scenario Template:**

```markdown
#### Scenario [N]
**Input**: [User request or situation]
**What [decision]?**
- A) [Option A]
- B) [Option B]

**Expert answer**: [Letter] ([option]) — [Why this is correct, what cues indicate it]
**Novice trap**: [What novices would choose and why it's wrong]
```

**Key principle**: Expert answer explains the CUE that makes the choice clear, not just the "right" answer.

### Expert Cues for Scoring

When scoring test evidence, use CDM-derived expert cues:

**Expert pattern (score 2-3):**
- [Specific observable behaviors that indicate expert-level performance]
- [Pattern recognition signals]
- [Appropriate adaptation signals]

**Novice pattern (score 0-1):**
- [Specific observable behaviors that indicate novice-level performance]
- [Over-generalization signals]
- [Fixed strategy signals]

---

## Phase Protocol

### Phase 0: TEST PLAN
Define JTBD, test pack, evidence output path, reproducibility metadata. Get user confirmation before proceeding.

### Phase 1: RED (Baseline)
Mode: Observation. Run JTBD without skill. Document gaps, failures, and friction points.

> **Why separate observation from diagnosis?** If you suggest fixes during RED, your baseline becomes contaminated — "baseline + improvements I noticed while observing." You lose the clean comparison that makes GREEN meaningful.

**Do**: Record what happens without the skill.
**Don't**: Suggest how a skill could help.
**Adapt**: Blend observation and diagnosis when you're exploring and don't yet know what to test — formal mode separation is for when you need uncontaminated evidence.

### Phase 2: GREEN (Verification)
Mode: Verification. Run JTBD with skill. Record what changed.

> **Why defer comparison?** Comparing during GREEN biases you toward confirming improvements you expect to see, rather than observing actual behavior. The comparison belongs in REPORT where you have both datasets side by side.

**Do**: Record what happens with the skill.
**Don't**: Compare to baseline or diagnose differences yet.
**Adapt**: Quick mental comparison is fine for obvious regressions — formal deferral is for subtle quality differences where bias matters.

### Phase 3: REFACTOR (Iteration)
Mode: Improvement. Identify the single weakest quality dimension and make one change. Re-run JTBD. Repeat.

> **Why one change at a time?** Multiple changes make it impossible to attribute improvement. When you change three things and scores improve, you don't know which change helped — and the one that hurt may be hiding behind the one that helped significantly.

**Do**: Propose single, targeted change to address weakest dimension.
**Don't**: Bundle multiple improvements into one iteration.
**Adapt**: Bundle changes when they're logically inseparable (e.g., adding a protocol step that requires a matching example).

**Comparator testing** (optional): When two iterations score similarly or after major restructuring:
1. Run same JTBD through version A and B
2. Anonymize outputs as "Alpha" / "Beta"
3. Send to a separate agent: "Compare these outputs on task completion, structural quality, domain accuracy, and conciseness. State which is stronger per dimension and give an overall verdict."

> **Why blind evaluation?** When you know which output came from the "improved" version, you unconsciously look for improvements rather than deficiencies. Anonymizing forces evaluation on output quality alone.

**Adapt**: Skip blind evaluation when the difference is obvious and you're confirming, not discovering.

### Phase 4: REPORT (Synthesis)
Mode: Synthesis. Aggregate findings across phases.

> **Why separate synthesis from analysis?** Generating new analysis during REPORT means you're testing with different criteria than you measured with — your report becomes untethered from your evidence. Synthesize only what you observed.

**Do**: Compare RED and GREEN evidence. Weight findings by convergence.
**Don't**: Generate new analysis or introduce new evaluation criteria.
**Adapt**: If REPORT reveals a gap in your measurement, note it as a follow-up test — don't patch it into the current report.

**Convergence weighting**: When independent quality dimensions surface the same issue, it's unlikely to be measurement noise. Issues from 2+ dimensions are critical. Single-dimension issues are improvement opportunities. Inconsistent findings across runs need re-investigation before conclusion.

> **Why weight by convergence?** A finding from one angle might be a measurement artifact. The same finding from two independent angles is a signal. Weight convergent findings by the *independence* of the signals — two closely related dimensions (Task Completion + Domain Accuracy) converging is weaker than two orthogonal dimensions (Iteration Count + Output Consistency) converging.

**Report structure**: Executive summary (does the skill work?) → Critical findings (convergent issues) → Dimension comparison (RED vs GREEN scores) → Improvement opportunities → Recommendation (keep / iterate further / retire).

---

## Quality Dimensions

Score each dimension 0-3:

| Dimension | What It Measures |
|-----------|------------------|
| **Task Completion** | Did output achieve the goal? |
| **Iteration Count** | How many rounds to reach goal? |
| **Output Consistency** | Same structure across runs? |
| **User Effort** | Clarifications/guidance needed? |
| **Domain Accuracy** | Appropriate patterns for domain? |

**Scoring Rubric:**

| Score | Meaning |
|-------|---------|
| 0 | Failed / Unacceptable |
| 1 | Partial / Needs significant work |
| 2 | Acceptable / Minor issues |
| 3 | Excellent / No issues |

### Quantitative Supplements

> **Why add quantitative metrics?** Qualitative scoring captures semantic quality but misses efficiency. A skill that produces excellent output but triples token usage may not be worth the cost. Quantitative metrics surface these tradeoffs.

| Metric | How to Measure | Signal |
|--------|---------------|--------|
| **Token usage** | Compare total tokens in skill vs no-skill session | >2x increase without quality gain flags verbosity |
| **Iteration count** | Exact user-model round trips to task completion | Complements the qualitative Iteration Count dimension with a precise number |
| **Wall-clock time** | Timestamp first prompt to final output | Large differences signal cost/benefit tradeoff worth investigating |

**Adapt**: Not all metrics are always measurable. Token counts require session metadata that may not be available. Record what you can — partial data is better than none.

---

## Variance Handling

LLM outputs are stochastic. To handle variance:

1. **Run 2-3 times per phase** (baseline, green, each refactor)
2. **Use median scores** for each dimension
3. **Allow small regressions** if justified (document reason)

**Minimum bar for GREEN**: Net improvement across dimensions. One dimension improving significantly can justify small regression in another.

---

## Evidence Storage

Evidence is stored centrally to keep skill directories clean:

```
legacy provider config home/test-evidence/
└── [skill-name]/
    └── [YYYY-MM-DD]-[slug]/
        ├── meta.json      # Reproducibility metadata
        ├── baseline.md
        ├── green.md
        ├── refactor-N.md
        └── report.md
```

**Tip**: Initialize `legacy provider config home/test-evidence/` as a Git repo to version-control evidence across all skills.

---

## Evidence Format

**meta.json** (for reproducibility):
```json
{
  "skill": "[skill-name]",
  "skillPath": "/path/to/skill",
  "skillSha": "[git SHA or 'uncommitted']",
  "model": "[model name]",
  "modelVersion": "[exact model identifier, e.g. claude-opus-4-5-20250220]",
  "toolsEnabled": ["Read", "Write", "..."],
  "testDate": "[ISO timestamp]",
  "jtbd": "[task description]",
  "metrics": {
    "tokenCount": 12500,
    "iterationCount": 3,
    "elapsedSeconds": 45
  }
}
```

Each evidence file should include:

```markdown
## [Phase] Evidence: [JTBD slug]

**Date**: [timestamp]
**Skill Version**: [path or "none" for baseline]
**Model**: [model used]
**Runs**: [N runs, using median]

### JTBD
[Exact task prompt given]

### Results by Dimension

| Dimension | Score | Evidence |
|-----------|-------|----------|
| Task Completion | [0-3] | "[quote or description]" |
| Iteration Count | [0-3] | [count] |
| Output Consistency | [0-3] | "[observation]" |
| User Effort | [0-3] | [clarification count] |
| Domain Accuracy | [0-3] | "[quote or observation]" |

### Assessment
**Overall**: [score sum]/15
**Weakest**: [dimension]
**Notes**: [observations, surprises]
```

---

## Reproducibility Metadata

For evidence to be interpretable, always record:

- **Model**: Exact model name/version
- **Tool availability**: Which tools were enabled
- **Temperature**: Default or specified
- **Fresh session procedure**: How to start clean (new terminal, `/clear`, etc.)
- **Skill version**: Git hash or "none" for baseline

---

## Iteration Protocol (REFACTOR Phase)

1. **Identify weakest dimension** from current scores
2. **Propose single change** (add constraint, restructure, add example)
3. **Get user confirmation** before applying
4. **Re-run JTBD** (2-3 runs)
5. **Record delta** in evidence

**Exit criteria** (any of):
- All dimensions at target (typically 2+)
- Diminishing returns (last 3 iterations < 1 point total improvement)
- User declares "good enough"

---

## Safety and Privacy

**Never store in test-evidence/:**
- API keys or secrets
- Personal data
- Credentials

**Redaction guidance:**
- Replace sensitive values with `[REDACTED]`
- Use placeholders: `user@example.com`, `sk-...`
- Document what was redacted

---

## Common Pitfalls

| Pitfall | Prevention |
|---------|------------|
| Skipping baseline | Always capture RED before GREEN |
| Multiple changes per iteration | One change only, validate, repeat |
| Single JTBD | Use test pack (primary + edge) |
| Ignoring variance | Run 2-3 times, use median |
| Subjective scoring | Use rubric, quote evidence |

---

## Skill Lifecycle

> **Why skills need lifecycle management**: Skills encode solutions to model limitations. As models improve, those limitations may disappear. A capability-uplift skill that once dramatically improved output may now add complexity without benefit. The only way to know is periodic baselining.

### When to Re-test

- **Model updates**: Re-run Phase 1 (RED baseline) after model version changes. Compare to prior baselines.
- **Capability announcements**: When the model vendor announces improvements in your skill's domain.
- **Decay signal**: When you notice the skill's instructions seem obvious or when users report diminishing value.

Record `modelVersion` in meta.json (see Evidence Format) to make baselines comparable across model generations.

### Retirement Signal

A skill is a candidate for retirement when:
1. No-skill baseline (RED) scores match or exceed skill-assisted (GREEN) scores across all quality dimensions
2. This result reproduces across 3+ runs (not variance)
3. The skill is primarily **capability uplift** (see [classification.md](./classification.md) Purpose Dimension)

> **Why only capability-uplift skills retire?** Encoded-preference skills encode team-specific workflows, not model techniques. No model improvement teaches your team's specific process. These skills don't retire — they evolve with the workflow.

**Adapt**: A mixed-purpose skill may partially retire. The capability-uplift aspects become unnecessary while the encoded-preference aspects remain valuable. In this case, distill (not retire) — remove the techniques the model learned, keep the workflow encoding.

---

## Quick Reference

```
/skill-architect test path/to/skill "JTBD"

Evidence: legacy provider config home/test-evidence/[skill-name]/[date]-[slug]/
```

See **Phase Protocol** above for detailed phase descriptions and cognitive isolation rules.
