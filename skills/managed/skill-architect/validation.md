# Cross-Model Validation Reference

CTA Simulation Interview protocol for validating skill distillation.
Used by `/skill-architect distill --validate`. See SKILL.md for the protocol overview.

---

## Why CTA Probes, Not Confidence Surveys

Self-reported confidence ("rate 1-5 how confident you are") is unfalsifiable — LLMs are
agreeable and will report high confidence even when missing critical context. CTA
Simulation Interview probes produce *behavioral data*: what the model actually attends
to, what decisions depend on which sections, and what changes when sections are removed.

---

## Attention Probing (Phase 2a)

Send to both `/codex` and `/gemini` via Skill tool. Each runs in an isolated subagent.

### Prompt Template

```
You are evaluating a skill definition by executing a task with it.

SKILL DEFINITION:
---
[full SKILL.md + relevant supporting file content]
---

TASK: [test scenario from Test Pack or --scenario flag]

Execute the task using the skill definition above. As you work, answer:

1. APPROACH: Walk through your approach step by step. At each decision point,
   quote the specific section heading and key phrase you're consulting.

2. FIRST NOTICE: What did you notice first in the skill that shaped your
   overall approach? Why did that section stand out?

3. UNUSED: Which sections did you never reference during execution?
   For each, explain why it wasn't relevant to this task.

4. DECISION DEPENDENCIES: List the 3 sections most critical to making
   correct decisions. For each, explain what would go wrong without it.
```

### Invoking Cross-Model Validation

**Tower runtime host:**
```
/codex "[prompt above]"
/gemini "[prompt above]"
```

**Codex CLI host (Gemini via shell, self-analysis replaces Codex):**
```bash
gemini -p "[prompt above]"
# Run self-analysis with a different prompt angle to compensate
```

**Gemini CLI host (Codex via shell, self-analysis replaces Gemini):**
```bash
codex exec --skip-git-repo-check -m gpt-5.2 -c model_reasoning_effort=high \
  -s read-only "[prompt above]"
# Run self-analysis with a different prompt angle to compensate
```

---

## Removal Probing (Phase 2b)

For each section classified as Reference or Bloat, test the classification by removing
it and observing behavioral changes. Batch sections by category to limit API calls.

### Prompt Template

```
You are evaluating a skill definition by executing a task with it.
Note: Some sections have been removed from this version.

SKILL DEFINITION (MODIFIED):
---
[skill content with target section(s) removed]
---

TASK: [same test scenario as Attention Probing]

Execute the task, then answer:

1. GAPS: Was there any point where you felt uncertain or wished you had
   more guidance? Describe the specific moment and what was missing.

2. DECISIONS: Were there any decisions where you had to guess because
   guidance was absent? What did you decide and why?

3. DELTA: Compare your approach to how you'd handle this with a complete
   skill definition. What, if anything, changed?
```

### Batching Strategy

- Remove all Bloat sections at once (single probe) — if no gaps reported, all confirmed
- Remove Reference sections one-at-a-time for high-value sections (>50 lines)
- Remove Reference sections in groups for small sections (<50 lines, same destination file)

---

## Delta Analysis (Phase 2c)

Host evaluates the combined probe results:

| Signal | Interpretation | Action |
|--------|---------------|--------|
| Both models never referenced a section | Strong Bloat/Reference confirmation | Classification stands |
| Both models quoted a section at decision points | Expert-Critical confirmed | Reclassify upward if needed |
| One model changed behavior on removal, other didn't | Model-specific dependency | Keep as Reference (accessible via link) |
| Either model reported gaps or guessing on removal | More critical than classified | Reclassify upward |
| Neither model reported gaps on Bloat removal | Bloat confirmed | Safe to condense/remove |

---

## Graceful Degradation

If one external model is unavailable (CLI not installed, auth failure):
- Run the available model's probes normally
- Host agent runs a second analysis pass with a **different prompt angle**:
  instead of "execute and report," use "review this skill for a junior developer —
  which sections are essential for them to get right?"
- This compensates for losing the second independent perspective

If both external models are unavailable:
- Host runs two self-analysis passes with different personas:
  1. "You are a model seeing this skill for the first time"
  2. "You are an experienced user who has run this skill 50 times"
- Flag in report that validation was host-only (lower confidence)

---

## Distill Quality Gate (Phase 2d)

Required when `--apply` is used. Verifies that the proposed distillation preserves output
quality by comparing original and distilled skill versions on the same task.

### When to Run

- **Always** before `--apply` rewrites files
- After RECONCILE (if `--validate` was used) or after ANALYZE (if `--apply` only)
- Skipped for `--validate` without `--apply` (Section Map is the deliverable)

### Protocol

1. **Select test JTBD**: Use the skill's Test Pack primary JTBD if one exists, or construct
   a representative task that exercises the skill's core decision points.

2. **Capture baseline**: Run the JTBD through the **original** (pre-distill) skill via
   `/codex` with the Attention Probing prompt template from Phase 2a. The skill definition
   embedded in the prompt must be the original, unmodified SKILL.md + supporting files.

3. **Capture post-distill**: Run the same JTBD through the **proposed distilled** skill via
   `/codex` with the same prompt template. The skill definition embedded must be the
   proposed distilled version (with extracted supporting files inlined or referenced).

4. **Score both** on 5 quality dimensions (from testing-guide.md):

   | Dimension | What to Compare |
   |-----------|----------------|
   | Task Completion | Did both versions complete the full protocol? |
   | Iteration Count | Did either version require more clarification rounds? |
   | Output Consistency | Are the structural artefacts equivalent? |
   | User Effort | Did the distilled version require more guidance? |
   | Domain Accuracy | Did domain-specific routing remain correct? |

5. **Compute delta**: For each dimension, delta = post-distill score - baseline score.

6. **Gate decision**:
   - **PASS**: No dimension degraded by >1 point → proceed to APPLY
   - **FAIL**: Any dimension degraded by >1 point → report which dimension failed,
     identify the removed/moved content that likely caused it, reclassify that content
     upward (Reference → Expert-Critical, or Bloat → Reference), and re-run the gate

### Evidence Storage

Store quality gate evidence alongside other test evidence:

```
legacy provider config home/test-evidence/[skill-name]/[YYYY-MM-DD]-distill-quality/
├── meta.json        # Skill SHA, model, timestamp, JTBD
├── baseline.md      # Original skill probe output + scores
├── distilled.md     # Distilled skill probe output + scores
└── delta.md         # Dimension-by-dimension comparison + gate verdict
```

### Scoring Template

Use for both baseline.md and distilled.md:

```markdown
## Quality Gate Evidence: [original|distilled]

**Skill Version**: [original SHA | proposed distilled]
**Model**: [model used for probe]
**JTBD**: [exact task prompt]

### Dimension Scores

| Dimension | Score (0-3) | Evidence |
|-----------|-------------|----------|
| Task Completion | [N] | [quote or observation] |
| Iteration Count | [N] | [count of rounds needed] |
| Output Consistency | [N] | [structural observation] |
| User Effort | [N] | [guidance needed] |
| Domain Accuracy | [N] | [routing/pattern observation] |

**Total**: [sum]/15
```

### Delta Template

```markdown
## Quality Gate Delta

| Dimension | Baseline | Distilled | Delta | Verdict |
|-----------|----------|-----------|-------|---------|
| Task Completion | [N] | [N] | [+/-N] | [PASS/FAIL] |
| Iteration Count | [N] | [N] | [+/-N] | [PASS/FAIL] |
| Output Consistency | [N] | [N] | [+/-N] | [PASS/FAIL] |
| User Effort | [N] | [N] | [+/-N] | [PASS/FAIL] |
| Domain Accuracy | [N] | [N] | [+/-N] | [PASS/FAIL] |

**Gate**: [PASS | FAIL]
**Failed dimensions**: [list or "none"]
**Suspected cause**: [which removed/moved content likely caused degradation]
```
